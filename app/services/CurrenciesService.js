/* eslint no-multi-spaces: ["error", { exceptions: { "VariableDeclarator": true } }] */
const _ = require('lodash');
const async = require('async');
const util = require('util');
const BigNumber = require('bignumber.js');
const network = require('../../config/network');
const Const = require('../common/Const');
const helper = require('../common/Utils');
const Utils = require('sota-core').load('util/Utils');
const BaseService = require('sota-core').load('service/BaseService');
const ExSession = require('sota-core').load('common/ExSession');
const logger = require('sota-core').getLogger('CurrenciesService');
const RedisCache = require('sota-core').load('cache/foundation/RedisCache');
const CacheInfo = require('../../config/cache/info');
const tokens = network.tokens;

module.exports = BaseService.extends({
  classname: 'CurrenciesService',

  getAllRateInfo: function (options, callback) {
    const startTime = new Date().getTime()


    const db = this._getDbConnection();
    //const tradeAdapter = db.model().getSlaveAdapter();
    const rateAdapter = db.model('Rate7dModel').getSlaveAdapter();

    let pairs = {}

    const nowInSeconds = Utils.nowInSeconds();
    const DAY_IN_SECONDS = 24 * 60 * 60;
    const dayAgo = nowInSeconds - DAY_IN_SECONDS;
    const hour30Ago = nowInSeconds - 30 * 60 * 60;
    const hour18Ago = nowInSeconds - 18 * 60 * 60;
    const weekAgo = nowInSeconds - DAY_IN_SECONDS * 7;

    const supportedTokenList = Object.keys(tokens).filter(token => {
      return (token.toUpperCase() !== "ETH") &&
            !tokens[token].delisted &&
            helper.shouldShowToken(token)
    }).join('\',\'')

    const lastSql = `
      SELECT mid_expected as 'rate_24h', quote_symbol
      FROM rate7d
      WHERE block_timestamp = (
          SELECT MAX(block_timestamp)
          FROM rate7d
          where block_timestamp < ?
      )
      AND quote_symbol IN ('${supportedTokenList}')
    `;
    const lastParams = [hour18Ago];


    const pointSql = `
      SELECT AVG(mid_expected) as rate7d, quote_symbol FROM rate 
      WHERE mid_expected > 0 AND block_timestamp >= ? 
            AND quote_symbol IN ('${supportedTokenList}')
      GROUP BY quote_symbol, h6_seq
    `
    const pointParams = [weekAgo];

    async.auto({
      lastRate: (next) => {
        rateAdapter.execRaw(lastSql, lastParams, next);
      },
      pointGraph: (next) => {
        rateAdapter.execRaw(pointSql, pointParams, next);
      }
    }, (err, ret) => {
      if(err) return callback(err)

      let pairs = {}
      Object.keys(tokens).forEach(token => {
        if ((token.toUpperCase() !== "ETH") &&
          !tokens[token].delisted &&
          helper.shouldShowToken(token)) {
            let indexLastRate = ret.lastRate ? ret.lastRate.map(l => l.quote_symbol).indexOf(token) : -1
            pairs[token] = {
              r: indexLastRate > -1 ? ret.lastRate[indexLastRate].rate_24h : 0,
              p: ret.pointGraph.filter(g => (g.quote_symbol == token)).map(i => i.rate7d)
            }
        }
      })

      const CACHE_KEY = CacheInfo.CurrenciesAllRates.key;
      const CACHE_TTL = CacheInfo.CurrenciesAllRates.TTL;
      const redisCacheService = this.getService('RedisCacheService');
      redisCacheService.setCacheByKey(CACHE_KEY, pairs, CACHE_TTL)
      const endTime = new Date().getTime()
      console.log(`______ saved to redis in ${endTime - startTime} ms, cache ${CACHE_TTL.ttl} s`)
      return callback(null, pairs)

    })














    // Object.keys(tokens).forEach(token => {
    //   if ((token.toUpperCase() !== "ETH") &&
    //     !tokens[token].delisted &&
    //     helper.shouldShowToken(token)) {
    //     pairs[token] = (asyncCallback) => this._getRateInfo(token, {
    //       //tradeAdapter: tradeAdapter,
    //       rateAdapter: rateAdapter
    //     }, asyncCallback)
    //   }
    // })
    // async.auto(pairs, (err, ret) => {
    //   db.destroy();
    //   if(err){
    //     logger.error(err)
    //     return callback(err)
    //   }
    //   const CACHE_KEY = CacheInfo.CurrenciesAllRates.key;
    //   const CACHE_TTL = CacheInfo.CurrenciesAllRates.TTL;
    //   const redisCacheService = this.getService('RedisCacheService');
    //   redisCacheService.setCacheByKey(CACHE_KEY, ret, CACHE_TTL)
    //   const endTime = new Date().getTime()
    //   console.log(`______ saved to redis in ${endTime - startTime} ms, cache ${CACHE_TTL.ttl} s`)
    //   callback(err, ret);
    // });



  },

  _getDbConnection: function () {
    let exSession = null;

    return {
      model: (modelName) => {
        modelName = modelName || 'KyberTradeModel';
        let model = this._exSession ? this.getModel(modelName) : undefined;
        if (!model) {
          exSession = new ExSession();
          model = exSession.getModel(modelName);
        }
        return model;
      },
      destroy: () => {
        if (exSession) {
          exSession.destroy();
          exSession = null;
        }
      }
    };
  },

  _getRateInfo: function (symbol, options, callback) {

    //const tradeAdapter = options.tradeAdapter;
    const rateAdapter = options.rateAdapter;

    const nowInSeconds = Utils.nowInSeconds();
    const DAY_IN_SECONDS = 24 * 60 * 60;
    const dayAgo = nowInSeconds - DAY_IN_SECONDS;
    const hour30Ago = nowInSeconds - 30 * 60 * 60;
    const hour18Ago = nowInSeconds - 18 * 60 * 60;
    const weekAgo = nowInSeconds - DAY_IN_SECONDS * 7;

    // volume SQL
    /*
    const tradeWhere = "block_timestamp >= ? AND (maker_token_symbol = ? OR taker_token_symbol = ?)";
    const tradeSql = `select IFNULL(sum(volume_eth),0) as ETH, IFNULL(sum(volume_usd),0) as USD from kyber_trade where ${tradeWhere}`;
    const tradeParams = [dayAgo, symbol, symbol];
    */

    // 24h price SQL
    const lastSql = `SELECT mid_expected as '24h' FROM rate7d
      WHERE quote_symbol = ? AND block_timestamp >= ? AND block_timestamp <= ? AND mid_expected > 0 ORDER BY ABS(block_timestamp - ${dayAgo}) LIMIT 1`;
    const lastParams = [symbol, hour30Ago, hour18Ago];

    // 7 days points
    //const pointSql = "select FLOOR(AVG(block_timestamp)) as timestamp, AVG(mid_expected) as rate from rate " +
    const pointSql = "select AVG(mid_expected) as rate7d from rate " +
      "where quote_symbol = ? AND mid_expected > 0 AND block_timestamp >= ? group by h6_seq";
    const pointParams = [symbol, weekAgo];

    async.auto({
      /*
      volume: (next) => {
        try {
          tradeAdapter.execRaw(tradeSql, tradeParams, next);
        } catch (ex) {
          logger.error(ex);
          next(ex, {});
        }
      },
      */
      rate: (next) => {
        try {
          rateAdapter.execRaw(lastSql, lastParams, next);
        } catch (ex) {
          logger.error(ex);
          next(ex, {});
        }
      },
      points: (next) => {
        try {
          rateAdapter.execRaw(pointSql, pointParams, next);
        } catch (ex) {
          logger.error(ex);
          next(ex, {});
        }
      }
    }, callback);
  },

  getConvertiblePairs: function (callback) {
    if (!tokens) return callback(null, {});

    let pairs = {};

    Object.keys(tokens).map(token => {
      // if((token.toUpperCase() !== "ETH") && !tokens[token].hidden){
      if ((token.toUpperCase() !== "ETH") &&
        !tokens[token].delisted &&
        helper.shouldShowToken(token)) {
        const cmcName = tokens[token].cmcSymbol || token;
        pairs["ETH_" + cmcName] = (asyncCallback) => this._getCurrencyInfo({
          token: token,
          fromCurrencyCode: "ETH"
        }, asyncCallback)
      }
    });

    async.auto(pairs, 10, (err, pairs)=>{
      if(err){
        pairs = {
          error:true,
          additional_data: err,
          reason:"server_error"
        }
      }
      callback(null, pairs);
    });
  },

  _getCurrencyInfo: function (options, callback) {
    if (!options.token || !tokens[options.token]) {
      return callback("token not supported")
    }

    if (!options.fromCurrencyCode || !tokens[options.fromCurrencyCode]) {
      return callback("base not supported")
    }

    let tokenSymbol = options.token
    let base = options.fromCurrencyCode
    let tokenData = tokens[tokenSymbol]
    let baseTokenData = tokens[base]

    const KyberTradeModel = this.getModel('KyberTradeModel');
    const CMCService = this.getService('CMCService');
    const nowInSeconds = Utils.nowInSeconds();
    const DAY_IN_SECONDS = 24 * 60 * 60;

    async.auto({
      baseVolume: (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: 'block_timestamp > ? AND (maker_token_symbol = ? OR taker_token_symbol = ?)',
          params: [nowInSeconds - DAY_IN_SECONDS, tokenSymbol, tokenSymbol],
        }, next);
      },
      quoteVolumeTaker: (next) => {
        KyberTradeModel.sum('taker_token_amount', {
          where: 'block_timestamp > ? AND taker_token_symbol = ?',
          params: [nowInSeconds - DAY_IN_SECONDS, tokenSymbol],
        }, next);
      },
      quoteVolumeMaker: (next) => {
        KyberTradeModel.sum('maker_token_amount', {
          where: 'block_timestamp > ? AND maker_token_symbol = ?',
          params: [nowInSeconds - DAY_IN_SECONDS, tokenSymbol],
        }, next);
      },
      price: (next) => {
        CMCService.getCurrentRate(tokenSymbol, base, next);
      },
      lastTrade: (next) => {
        KyberTradeModel.findOne({
          where: 'taker_token_symbol = ? OR maker_token_symbol = ?',
          params: [tokenSymbol, tokenSymbol],
          orderBy: 'block_timestamp DESC',
        }, next)
      }
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }

      let lastPrice = 0
      if (ret.lastTrade) {
        let bigMakerAmount = ret.lastTrade.makerTokenAmount ? new BigNumber(ret.lastTrade.makerTokenAmount) : new BigNumber(0)
        let bigTakerAmount = ret.lastTrade.takerTokenAmount ? new BigNumber(ret.lastTrade.takerTokenAmount) : new BigNumber(0)

        if (ret.lastTrade.takerTokenSymbol != tokenSymbol && !bigMakerAmount.isZero()) {
          let amountTaker = ret.lastTrade.volumeEth; //bigTakerAmount.div(Math.pow(10, baseTokenData.decimal))
          let amountMaker = bigMakerAmount.div(Math.pow(10, tokenData.decimal));
          lastPrice = new BigNumber(amountTaker).div(amountMaker).toNumber()
        }
        else if (ret.lastTrade.makerTokenSymbol != tokenSymbol && !bigTakerAmount.isZero()) {
          let amountMaker = ret.lastTrade.volumeEth; //bigMakerAmount.div(Math.pow(10, baseTokenData.decimal))
          let amountTaker = bigTakerAmount.div(Math.pow(10, tokenData.decimal))
          lastPrice = new BigNumber(amountMaker).div(amountTaker).toNumber()
        }

      }

      // const baseVolume = new BigNumber(ret.baseVolume.toString()).div(Math.pow(10, baseTokenData.decimal)).toNumber()
      let bigQuoteVolumeTaker = ret.quoteVolumeTaker ? new BigNumber(ret.quoteVolumeTaker.toString()) : new BigNumber(0)
      let bigQuoteVolumeMaker = ret.quoteVolumeMaker ? new BigNumber(ret.quoteVolumeMaker.toString()) : new BigNumber(0)
      const quoteVolume = bigQuoteVolumeTaker.plus(bigQuoteVolumeMaker).div(Math.pow(10, tokenData.decimal)).toNumber()
      const currentPrice = ret.price ? new BigNumber(ret.price.rate.toString()).div(Math.pow(10, baseTokenData.decimal)) : null
      return callback(null, {
        "symbol": tokenData.cmcSymbol || tokenData.symbol,
        "name": tokenData.name,
        // "code": tokenData.symbol,
        "contractAddress": tokenData.address,
        "decimals": tokenData.decimal,
        currentPrice: currentPrice.toNumber(),
        lastPrice: lastPrice,
        lastTimestamp: ret.lastTrade ? ret.lastTrade.blockTimestamp : null,
        baseVolume: ret.baseVolume,
        quoteVolume: quoteVolume
      })
    })
  },

  getPair24hData: function (options, callback) {
    console.log("************* run to get PAIR24H in service")
    const startTime = new Date().getTime()

    if (!tokens) return callback(null, {});
    let pairs = {};



    const supportedTokenList = Object.keys(tokens).filter(token => {
      return (token.toUpperCase() !== "ETH") &&
            !tokens[token].delisted &&
            helper.shouldShowToken(token)
    }).join('\',\'')


    const tradeAdapter = this.getModel('KyberTradeModel').getSlaveAdapter()
    const rateAdapter = this.getModel('Rate7dModel').getSlaveAdapter()
    const nowInMs = Date.now();
    const nowInSeconds = Math.floor(nowInMs / 1000);
    const DAY_IN_SECONDS = 24 * 60 * 60;
    const dayAgo = nowInSeconds - DAY_IN_SECONDS;
    const weekAgo = nowInSeconds - DAY_IN_SECONDS * 7;
    //volume token base
    const volumeSql = `
      SELECT sum(volume_token) as volume_24h_token, sum(volume_usd) as volume_24h_usd, sum(volume_eth) as volume_24h_eth, token_symbol
      FROM 
        (SELECT IFNULL(sum(maker_token_amount),0) as volume_token, IFNULL(sum(volume_usd),0) as volume_usd, IFNULL(sum(volume_eth),0) as volume_eth, maker_token_symbol as token_symbol
        FROM kyber_trade
        WHERE block_timestamp > ?
        AND maker_token_symbol IN ('${supportedTokenList}')
        GROUP BY maker_token_symbol
          UNION ALL
        SELECT IFNULL(sum(taker_token_amount),0) as volume_token, IFNULL(sum(volume_usd),0) as volume_usd, IFNULL(sum(volume_eth),0) as volume_eth, taker_token_symbol as token_symbol 
        FROM kyber_trade 
        WHERE block_timestamp > ?
        AND taker_token_symbol IN ('${supportedTokenList}')
        GROUP BY taker_token_symbol
        )a
      GROUP BY token_symbol
    `;
    const volumeParams = [dayAgo, dayAgo];


    // 24h price SQL
    const maxRateSql = `SELECT max(buy_expected) as 'past_24h_high', min(sell_expected) as 'past_24h_low', quote_symbol
      FROM rate7d
      WHERE block_timestamp > ? AND buy_expected > 0 AND sell_expected > 0
      AND quote_symbol IN ('${supportedTokenList}')
      GROUP BY quote_symbol`;
    const maxRateParams = [dayAgo];

    // last price SQL
    const lastRateSql = `SELECT buy_expected as 'current_ask', sell_expected as 'current_bid', quote_symbol
      FROM rate7d
      WHERE block_number IN (
          SELECT MAX(block_number)
          FROM rate7d
          WHERE quote_symbol IN ('${supportedTokenList}')
          GROUP BY quote_symbol
      );`;
    const lastRateParams = [];

    // last price SQL
    const lastTradeMakerSql = `SELECT *
      FROM kyber_trade
      WHERE id IN
      (
          SELECT MAX(id)
          FROM kyber_trade
          where block_timestamp > ?
          AND maker_token_symbol IN ('${supportedTokenList}')
          GROUP BY maker_token_symbol
      )`;
    const lastTradeTakerSql = `SELECT *
      FROM kyber_trade
      WHERE id IN
      (
          SELECT MAX(id)
          FROM kyber_trade
          where block_timestamp > ?
          AND taker_token_symbol IN ('${supportedTokenList}')
          GROUP BY taker_token_symbol
      )
      `;
    const lastTradeParams = [weekAgo];

    async.auto({
      volume: (next) => tradeAdapter.execRaw(volumeSql, volumeParams, next),
      maxRate: (next) => rateAdapter.execRaw(maxRateSql, maxRateParams, next),
      lastRate: (next) =>rateAdapter.execRaw(lastRateSql, lastRateParams, next),
      lastTradeMaker: (next) => tradeAdapter.execRaw(lastTradeMakerSql, lastTradeParams, next),
      lastTradeTaker: (next) => tradeAdapter.execRaw(lastTradeTakerSql, lastTradeParams, next)
    }, (err, ret) => {
      console.log('===================', err)
      if(err) return callback(err)

      let pairs = {}
      Object.keys(tokens).map(token => {
        if ((token.toUpperCase() !== "ETH") &&
          !tokens[token].delisted &&
          helper.shouldShowToken(token)) {

            pairs["ETH_" + token] = {
              timestamp: nowInMs,
              quote_symbol: token,
              base_symbol: 'ETH',
              past_24h_high: 0,
              past_24h_low: 0,
              usd_24h_volume:  0,
              eth_24h_volume: 0,
              token_24h_volume: 0,
              current_bid: 0,
              current_ask:  0,
              last_traded: 0
            }

            let indexVolume = ret.volume ? ret.volume.map(v => v.token_symbol).indexOf(token) : -1
            if(indexVolume > -1){
              pairs["ETH_" + token].usd_24h_volume = ret.volume[indexVolume].volume_24h_usd
              pairs["ETH_" + token].token_24h_volume = new BigNumber(ret.volume[indexVolume].volume_24h_token ? ret.volume[indexVolume].volume_24h_token.toString() : 0).div(Math.pow(10, tokens[token].decimal)).toNumber()
              pairs["ETH_" + token].eth_24h_volume = ret.volume[indexVolume].volume_24h_eth
            }

            let indexMaxRate = ret.maxRate ? ret.maxRate.map(m => m.quote_symbol).indexOf(token) : -1
            if(indexMaxRate > -1){
              pairs["ETH_" + token].past_24h_high = ret.maxRate[indexMaxRate].past_24h_high
              pairs["ETH_" + token].past_24h_low = ret.maxRate[indexMaxRate].past_24h_low
            }

            let indexLastRate = ret.lastRate ? ret.lastRate.map(l => l.quote_symbol).indexOf(token) : -1
            if(indexLastRate > -1 ){
              pairs["ETH_" + token].current_bid = ret.lastRate[indexLastRate].current_bid
              pairs["ETH_" + token].current_ask = ret.lastRate[indexLastRate].current_ask
            }

            let indexlastMakerTrade = ret.lastTradeMaker ? ret.lastTradeMaker.map(l => l.maker_token_symbol).indexOf(token) : -1
            let indexlastTakerTrade = ret.lastTradeTaker ? ret.lastTradeTaker.map(l => l.taker_token_symbol).indexOf(token) : -1
            
            if(indexlastMakerTrade > -1 || indexlastTakerTrade > -1){
              let lastPrice = 0
              let lastMakerTrade = indexlastMakerTrade > -1 ? ret.lastTradeMaker[indexlastMakerTrade] : null
              let lastTakerTrade = indexlastTakerTrade > -1 ? ret.lastTradeTaker[indexlastTakerTrade] : null

              let lastTokenTrade = lastMakerTrade
              if(!lastMakerTrade || (lastTakerTrade && lastTakerTrade.blockTimestamp > lastMakerTrade.blockTimestamp)){
                lastTokenTrade = lastTakerTrade
              }


              // let lastTokenTrade = ret.lastTrade[indexlastTrade]
              let bigMakerAmount = new BigNumber(lastTokenTrade.maker_token_amount ? lastTokenTrade.maker_token_amount.toString() : 0)
              let bigTakerAmount = new BigNumber(lastTokenTrade.taker_token_amount ? lastTokenTrade.taker_token_amount.toString() : 0)

              if (lastTokenTrade.taker_token_symbol !== token && !bigMakerAmount.isZero()) {
                let amountMaker = bigMakerAmount.div(Math.pow(10, tokens[token].decimal));
                let amountTaker = lastTokenTrade.volume_eth ? lastTokenTrade.volume_eth.toString() : 0;
                lastPrice = new BigNumber(amountTaker).div(amountMaker).toNumber()
              }
              else if (lastTokenTrade.maker_token_symbol !== token && !bigTakerAmount.isZero()) {
                let amountTaker = bigTakerAmount.div(Math.pow(10, tokens[token].decimal))
                let amountMaker = lastTokenTrade.volume_eth ? lastTokenTrade.volume_eth.toString() : 0;
                lastPrice = new BigNumber(amountMaker).div(amountTaker).toNumber()
              }
              pairs["ETH_" + token].last_traded = lastPrice
            }
          }
        });


      const CACHE_KEY = CacheInfo.Pair24hData.key;
      const CACHE_TTL = CacheInfo.Pair24hData.TTL;
      const redisCacheService = this.getService('RedisCacheService');
      redisCacheService.setCacheByKey(CACHE_KEY, pairs, CACHE_TTL)
      const endTime = new Date().getTime()
      console.log(`______ saved 24H PAIRS to redis in ${endTime - startTime} ms, cache ${CACHE_TTL.ttl} s`)
      return callback(null, pairs)
  



    // Object.keys(tokens).map(token => {
    //   if ((token.toUpperCase() !== "ETH") &&
    //     !tokens[token].delisted &&
    //     helper.shouldShowToken(token)) {
    //     pairs["ETH_" + token] = (asyncCallback) => this._getPair24hData({
    //       tradeAdapter: this.getModel('KyberTradeModel').getSlaveAdapter(),
    //       rateAdapter: this.getModel('Rate7dModel').getSlaveAdapter(),
    //       token: token,
    //       fromCurrencyCode: "ETH"
    //     }, asyncCallback)
    //   }
    // });

    // pairs.allRates = this.getService('CMCService').getAllRates;
    // const CACHE_KEY = CacheInfo.Pair24hData.key;
    // const CACHE_TTL = CacheInfo.Pair24hData.TTL;
    // const redisCacheService = this.getService('RedisCacheService');



    // async.auto(pairs, 10, function (err, pairs) {
    //   if(err) return callback(err)

    //   if (!err) {
    //     const rates = pairs.allRates;
    //     delete pairs.allRates;
    //     Object.values(pairs).forEach((value) => {
    //       const askrate = rates.getRate(value.base_symbol, value.quote_symbol);
    //       const normalAsk = askrate ? (1 / askrate) : 0;
    //       const normalBid = rates.getRate(value.quote_symbol, value.base_symbol);
    //       if (normalAsk) {
    //         value.current_ask = normalAsk;
    //       }
    //       if (value.current_ask > value.past_24h_high) {
    //         value.past_24h_high = value.current_ask;
    //       }

    //       if (normalBid) {
    //         value.current_bid = normalBid;
    //       }
    //       if (value.current_bid < value.past_24h_low) {
    //         value.past_24h_low = value.current_bid;
    //       }

    //     });
    //   }

      
    //   redisCacheService.setCacheByKey(CACHE_KEY, pairs, CACHE_TTL)
    //   const endTime = new Date().getTime()
    //   console.log(`______ saved 24H PAIRS to redis in ${endTime - startTime} ms, cache ${CACHE_TTL.ttl} s`)


    //   callback(null, pairs);
    });
  },

  _getPair24hData: function (options, callback) {
    if (!options.token || !tokens[options.token]) {
      return callback("token not supported")
    }

    if (!options.fromCurrencyCode || !tokens[options.fromCurrencyCode]) {
      return callback("base not supported")
    }

    let tokenSymbol = options.token
    let baseSymbol = options.fromCurrencyCode
    let tokenData = tokens[tokenSymbol]

    const nowInMs = Date.now();
    const nowInSeconds = Math.floor(nowInMs / 1000);
    const DAY_IN_SECONDS = 24 * 60 * 60;
    const dayAgo = nowInSeconds - DAY_IN_SECONDS;
    const KyberTradeModel = this.getModel('KyberTradeModel');
    // volume SQL
    const tradeWhere = 'block_timestamp > ? AND (maker_token_symbol = ?  OR  taker_token_symbol = ?)';
    const tradeSql = `select IFNULL(sum(volume_usd),0) as usd_24h_volume, IFNULL(sum(volume_eth),0) as eth_24h_volume from kyber_trade where ${tradeWhere}`;
    const tradeParams = [dayAgo, tokenSymbol, tokenSymbol];

    // 24h price SQL
    const rateSql = `SELECT max(buy_expected) as 'past_24h_high', min(sell_expected) as 'past_24h_low' FROM rate7d
      WHERE quote_symbol = ? AND block_timestamp > ? AND buy_expected > 0 AND sell_expected > 0`;
    const rateParams = [tokenSymbol, dayAgo];

    // last price SQL
    const lastSql = `SELECT buy_expected as 'current_ask', sell_expected as 'current_bid' FROM rate7d
      WHERE quote_symbol = ? AND buy_expected > 0 AND sell_expected > 0
      ORDER BY block_number DESC LIMIT 1`;
    const lastParams = [tokenSymbol];

    //volume token base
    const volumeSql = `SELECT sum(volume_) as volume FROM 
    (SELECT IFNULL(sum(maker_token_amount),0) as volume_ FROM kyber_trade where block_timestamp > ? AND maker_token_symbol = ?
      UNION ALL
      SELECT IFNULL(sum(taker_token_amount),0) as volume_ FROM kyber_trade where block_timestamp > ? AND taker_token_symbol = ?
    )a`;
    const volumeParams = [dayAgo, tokenSymbol, dayAgo, tokenSymbol];

    async.auto({
      trade: (next) => {
        options.tradeAdapter.execRaw(tradeSql, tradeParams, next);
      },
      rate: (next) => {
        options.rateAdapter.execRaw(rateSql, rateParams, next);
      },
      latest: (next) => {
        options.rateAdapter.execRaw(lastSql, lastParams, next);
      },
      volume: (next) => {
        options.tradeAdapter.execRaw(volumeSql, volumeParams, next);
      },
      lastTrade: (next) => {
        KyberTradeModel.findOne({
          where: 'taker_token_symbol = ? OR maker_token_symbol = ?',
          params: [tokenSymbol, tokenSymbol],
          orderBy: 'block_timestamp DESC',
        }, next)
      }
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }
      let lastPrice = 0
      if (ret.lastTrade) {
        let bigMakerAmount = ret.lastTrade.makerTokenAmount ? new BigNumber(ret.lastTrade.makerTokenAmount) : new BigNumber(0)
        let bigTakerAmount = ret.lastTrade.takerTokenAmount ? new BigNumber(ret.lastTrade.takerTokenAmount) : new BigNumber(0)

        if (ret.lastTrade.takerTokenSymbol !== tokenSymbol && !bigMakerAmount.isZero()) {
          let amountTaker = ret.lastTrade.volumeEth; //bigTakerAmount.div(Math.pow(10, baseTokenData.decimal))
          let amountMaker = bigMakerAmount.div(Math.pow(10, tokenData.decimal));
          lastPrice = new BigNumber(amountTaker).div(amountMaker).toNumber()
        }
        else if (ret.lastTrade.makerTokenSymbol !== tokenSymbol && !bigTakerAmount.isZero()) {
          let amountMaker = ret.lastTrade.volumeEth; //bigMakerAmount.div(Math.pow(10, baseTokenData.decimal))
          let amountTaker = bigTakerAmount.div(Math.pow(10, tokenData.decimal))
          lastPrice = new BigNumber(amountMaker).div(amountTaker).toNumber()
        }
      }
      const quoteVolume = ret.volume[0].volume ? new BigNumber(ret.volume[0].volume.toString()).div(Math.pow(10, tokenData.decimal)).toNumber() : 0
      return callback(null, {
        timestamp: nowInMs,
        quote_symbol: tokenSymbol,
        base_symbol: baseSymbol,
        past_24h_high: ret.rate.length ? (ret.rate[0].past_24h_high || 0) : 0,
        past_24h_low: ret.rate.length ? (ret.rate[0].past_24h_low || 0) : 0,
        usd_24h_volume: ret.trade.length ? (ret.trade[0].usd_24h_volume || 0) : 0,
        eth_24h_volume: ret.trade.length ? (ret.trade[0].eth_24h_volume || 0) : 0,
        token_24h_volume: quoteVolume,
        current_bid: ret.latest.length ? (ret.latest[0].current_bid || 0) : 0,
        current_ask: ret.latest.length ? (ret.latest[0].current_ask || 0) : 0,
        last_traded: lastPrice
      })
    })
  },

  // get 24h change by eth
  get24hChangeData: function (options, callback) {
    if (!tokens) return callback(null, {});

    let pairs = {};

    Object.keys(tokens).map(token => {
      // if((token.toUpperCase() !== "ETH") && !tokens[token].hidden){
      if ((token.toUpperCase() !== "ETH") &&
        !tokens[token].delisted &&
        helper.shouldShowToken(token)) {
        const cmcName = tokens[token].cmcSymbol || token;
        pairs["ETH_" + cmcName] = (asyncCallback) => this._get24hChangeData({
          rateAdapter: this.getModel('Rate7dModel').getSlaveAdapter(),
          token: token,
          fromCurrencyCode: "ETH",
        }, asyncCallback)
      }
    });

    if (options.usd) {
      const nowInMs = Date.now();
      const DAY_IN_MSSECONDS = 24 * 60 * 60 * 1000;
      const dayAgo = nowInMs - DAY_IN_MSSECONDS;
      const cmcService = this.getService('CMCService');
      pairs.price_now_eth = (callback) => {
        cmcService.getCurrentPrice('ETH', callback);
      };
      pairs.price_24h_eth = (callback) => {
        cmcService.getHistoricalPrice('ETH', dayAgo, callback);
      }
    }
    pairs.allRates = this.getService('CMCService').getAllRates;
    // async.auto(pairs, 10, callback);
    async.auto(pairs, 10, function (err, pairs) {
      if (err) {
        callback(err, pairs);
        return;
      }
      let price_now_eth = "-";
      let price_24h_eth = "-";
      const rates = pairs.allRates;

      delete pairs.allRates;

      if (pairs.price_now_eth && pairs.price_24h_eth) {
        price_now_eth = pairs.price_now_eth;
        price_24h_eth = pairs.price_24h_eth.price_usd;
        delete pairs.price_now_eth;
        delete pairs.price_24h_eth;
        Object.values(pairs).forEach((value) => {
          let change_usd_24h = "-", rate_usd_now = "-";
          const rate_production_cache = _.find(rates.data, (x) => {
            return x.source === value.token_symbol
          });
          if (rate_production_cache && rate_production_cache.rate !== 0) {
            value.rate_eth_now = new BigNumber(rate_production_cache.rate).div(Math.pow(10, 18)).toNumber();
          }
          if (value.rate_eth_now && value.old_rate_eth) {
            change_usd_24h = 0;
            if (value.old_rate_eth !== 0) {
              change_usd_24h = (((value.rate_eth_now * price_now_eth) - (value.old_rate_eth * price_24h_eth)) * 100) / (value.old_rate_eth * price_24h_eth);
            }
          }
          if (value.rate_eth_now) {
            rate_usd_now = value.rate_eth_now * price_now_eth
          }
          value.change_usd_24h = change_usd_24h;
          value.rate_usd_now = rate_usd_now;
          delete value.old_rate_eth;
        });
      } else {
        Object.values(pairs).forEach((value) => {
          const rate_production_cache = _.find(rates.data, (x) => {
            return x.source === value.token_symbol
          });
          if (rate_production_cache && rate_production_cache.rate !== 0) {
            value.rate_eth_now = new BigNumber(rate_production_cache.rate).div(Math.pow(10, 18)).toNumber();
          }
          delete value.change_usd_24h;
          delete value.rate_usd_now;
          delete value.old_rate_eth;
        });
      }

      //add ETH_ETH
      pairs["ETH_ETH"] = {
        timestamp: Date.now(),
        token_name: tokens["ETH"].name,
        token_symbol: tokens["ETH"].symbol,
        token_decimal: tokens["ETH"].decimal,
        token_address: tokens["ETH"].address,
        rate_eth_now: 1,
        change_eth_24h: "-",
      };
      if (options.usd) {
        let change_usd_24h = "-";
        if (price_now_eth !== "-" && price_24h_eth !== "-" && price_24h_eth !== 0) {
          change_usd_24h = (price_now_eth - price_24h_eth) * 100 / price_24h_eth
        }
        pairs["ETH_ETH"].change_usd_24h = change_usd_24h;
        pairs["ETH_ETH"].rate_usd_now = price_now_eth !== "-" ? parseFloat(price_now_eth) : price_now_eth;
      }
      callback(err, pairs);
    });
  },

  _get24hChangeData: function (options, callback) {
    if (!options.token || !tokens[options.token]) {
      return callback("token not supported")
    }

    if (!options.fromCurrencyCode || !tokens[options.fromCurrencyCode]) {
      return callback("base not supported")
    }
    const CACHE_KEY = CacheInfo.Change24h.key + options.token;
    RedisCache.getAsync(CACHE_KEY, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      let tokenSymbol = options.token;
      // let baseSymbol = options.fromCurrencyCode
      let tokenData = tokens[tokenSymbol]

      const nowInMs = Date.now();
      const nowInSeconds = Math.floor(nowInMs / 1000);
      const DAY_IN_SECONDS = 24 * 60 * 60;
      const dayAgo = nowInSeconds - DAY_IN_SECONDS;
      const hour30Ago = nowInSeconds - 30 * 60 * 60;
      const hour18Ago = nowInSeconds - 18 * 60 * 60;
      const hour1Ago = nowInSeconds - 1 * 60 * 60;

      // 24h price SQL
      const lastSql = `SELECT mid_expected as 'rate_eth_24h' FROM rate7d
     WHERE quote_symbol = ? AND block_timestamp >= ? AND block_timestamp <= ? AND mid_expected > 0 ORDER BY ABS(block_timestamp - ${dayAgo}) LIMIT 1`;
      const lastParams = [tokenSymbol, hour30Ago, hour18Ago];

      const rateNowSql = `SELECT mid_expected as 'rate_eth_now' FROM rate7d WHERE quote_symbol = ? AND block_timestamp >= ? AND mid_expected > 0 ORDER BY block_timestamp DESC LIMIT 1`;
      const rateNowParams = [tokenSymbol, hour1Ago];

      async.auto({
        rate: (next) => {
          options.rateAdapter.execRaw(lastSql, lastParams, next);
        },
        rateNow: (next) => {
          options.rateAdapter.execRaw(rateNowSql, rateNowParams, next);
        }
      }, (err, ret) => {
        if (err) {
          return callback(err);
        }
        const old_rate_eth = ret.rate.length ? ret.rate[0].rate_eth_24h || 0 : null;
        const rate_eth_now = ret.rateNow.length ? ret.rateNow[0].rate_eth_now || 0 : null;
        let change_eth_24h = "-";
        if (old_rate_eth && rate_eth_now) {
          change_eth_24h = 0;
          if (old_rate_eth !== 0) {
            change_eth_24h = (rate_eth_now - old_rate_eth) * 100 / old_rate_eth;
          }
        }
        let data = {
          timestamp: nowInMs,
          token_name: tokenData.name,
          token_symbol: tokenSymbol,
          token_decimal: tokenData.decimal,
          // base_symbol: baseSymbol,
          token_address: tokenData.address,
          rate_eth_now: rate_eth_now,
          old_rate_eth: old_rate_eth,
          change_eth_24h: change_eth_24h,
        };
        RedisCache.setAsync(CACHE_KEY, JSON.stringify(data), CacheInfo.Change24h.TTL);
        return callback(null, data)
      })
    });
  },
});
