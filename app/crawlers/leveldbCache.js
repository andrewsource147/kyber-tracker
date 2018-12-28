require('dotenv').config();
const _         = require('lodash');
const async     = require('async');
const level     = require('level');
const path      = require('path');
const request   = require('superagent');
// const tokens    = require('../../config/network').tokens;
const Utils     = require('../common/Utils');
const logger    = require('sota-core').getLogger('leveldbCache');
const web3      = Utils.getWeb3Instance();
const network = require('../../config/network');
const CONSTANTS = require('../common/Const')
// TODO: refactor this mess
const db = level(path.join(__dirname, '../../db/level'));
const LOCAL_CMC_DATA = {};

logger.info('+++++++internal contract', network.contractAddresses.internal)
const internalContract = new web3.eth.Contract(CONSTANTS.ABIS.INTERNAL_NETWORK, network.contractAddresses.internal)


function getBlockTimestamp (blockNumber, callback) {
  const key = getBlockTimestampKey(blockNumber);
  db.get(key, (err, ret) => {
    if (err) {
      queryBlockTimestampFromNetwork(blockNumber, callback);
      return;
    }

    if (!ret || isNaN(ret)) {
      logger.warn(`Invalid saved data for block ${blockNumber}. Will remove from db...`);
      db.del(key, (err) => {
        if (err) {
          logger.warn(`Error when remove data of block ${blockNumber}`);
        }
      });
      queryBlockTimestampFromNetwork(blockNumber, callback);
      return;
    }

    logger.trace(`Cache hit! Block ${blockNumber} time: ${ret}`);
    return callback(null, parseInt(ret));
  });
};

function getCoinPrice (symbol, timestamp, callback) {
  const tokenInfo = global.GLOBAL_TOKEN[symbol];
  if (!tokenInfo) {
    return callback(`getCoinPrice: could not find info of [${symbol}] token.`);
  }

  const key = getCoinPriceKey(symbol, timestamp);
  db.get(key, (err, ret) => {
    if (err) {
      queryCoinPriceFromNetwork(tokenInfo, timestamp, callback);
      return;
    }

    if (isNaN(ret)) {
      logger.warn(`Invalid saved data for coin ${symbol} at ${timestamp}. Will remove from db...`);
      db.del(key, (err) => {
        if (err) {
          logger.warn(`Error when remove data of coin ${symbol} at ${timestamp}`);
        }
      });
      queryCoinPriceFromNetwork(tokenInfo, timestamp, callback);
      return;
    }

    logger.trace(`Cache hit! Price of ${symbol} at ${timestamp} is: ${ret}`);
    return callback(null, parseFloat(ret));
  });
}

function getBlockTimestampKey (blockNumber) {
  return `block_timestamp_${blockNumber}`;
}

function getCoinPriceKey (symbol, timestamp) {
  return `price_${symbol}_${timestamp}`;
}

function queryBlockTimestampFromNetwork (blockNumber, callback) {
  web3.eth.getBlock(blockNumber, (err, block) => {
    if (err) {
      return callback(err);
    }

    logger.trace(`Requeried! Block ${blockNumber} time: ${block.timestamp}`);
    const key = getBlockTimestampKey(blockNumber);
    db.put(key, block.timestamp, (_err) => {
      if (_err) {
        logger.warn(`Something went wrong when updating block timestamp to DB: ${_err.toString()}`);
      }

      return callback(null, block.timestamp);
    });
  });
}

function queryCoinPriceFromNetwork (tokenInfo, timestamp, callback) {
  const timeInMillis = timestamp * 1000;
  const symbol = tokenInfo.symbol;

  let needFetch = false;
  if (!LOCAL_CMC_DATA[symbol]) {
    needFetch = true;
  } else {
    prices = LOCAL_CMC_DATA[symbol].price_usd;
    if (!prices || !prices.length) {
      needFetch = true;
    } else {
      // Before CMC begins, price was zero
      if (timeInMillis <= prices[0][0]) {
        return callback(null, prices[0][1]);
      }

      const len = prices.length;
      if (timeInMillis > prices[len-1][0]) {
        needFetch = true;
      }
    }
  }

  if (!needFetch) {
    searchPriceInLocalData(tokenInfo, timeInMillis, LOCAL_CMC_DATA[symbol].price_usd, callback);
    return;
  }

  fetchCMCData(tokenInfo, (err, ret) => {
    if (err) {
      return callback(err);
    }

    searchPriceInLocalData(tokenInfo, timeInMillis, LOCAL_CMC_DATA[symbol].price_usd, callback);
  });
}

function fetchCMCData (tokenInfo, callback) {
  request
    .get(`https://graphs2.coinmarketcap.com/currencies/${tokenInfo.cmcId}/`)
    .end((err, response) => {
      if (err) {
        return callback(`Could not get price history of ${tokenInfo.symbol} token from CMC: ${err.toString()}`);
      }

      LOCAL_CMC_DATA[tokenInfo.symbol] = response.body;
      return callback(null, true);
    });
}

function searchPriceInLocalData (tokenInfo, timeInMillis, prices, callback) {
  const timestamp = Math.floor(timeInMillis / 1000);
  const symbol = tokenInfo.symbol;
  const key = getCoinPriceKey(symbol, timestamp);
  if (!prices || !prices.length) {
    return callback(`searchPriceInLocalData: no data to search for ${tokenInfo.symbol} at ${timeInMillis}`);
  }

  const len = prices.length;
  if (timeInMillis < prices[0][0]) {
    return callback(`Could not get price of [${symbol}] at ${timeInMillis}`);
  }

  if (timeInMillis > prices[len-1][0]) {
    request
      .get(`https://api.coinmarketcap.com/v1/ticker/${tokenInfo.cmcId}/`)
      .end((err, response) => {
        if (err) {
          return callback(`Could not get ticker data of ${tokenInfo.symbol} from CMC: ${err.toString()}`);
        }

        let price;
        try {
          price = parseFloat(response.body[0].price_usd);
        } catch (e) {
          return callback(e);
        }

        return callback(null, price);
      });
    return;
  }

  if (len <= 2) {
    const price = parseFloat(prices[0][1]);
    db.put(key, price)
    return callback(null, price);
  }

  const searchIndex = Math.floor(len / 2);
  if (timeInMillis === prices[searchIndex][0]) {
    const price = parseFloat(prices[searchIndex][1]);
    db.put(key, price);
    return callback(null, price);
  }

  if (timeInMillis < prices[searchIndex][0]) {
    searchPriceInLocalData(tokenInfo, timeInMillis, prices.slice(0, searchIndex), callback);
  } else {
    searchPriceInLocalData(tokenInfo, timeInMillis, prices.slice(searchIndex, len), callback);
  }
}

function getAllReserve(callback){
  return internalContract.methods.getReserves().call(callback)
}

function getReserveType (reserveAddr, callback){
  return internalContract.methods.reserveType(reserveAddr).call(callback)
}

function getReserveTokensList (reserveAddr, callback){
  const reserveContract = new web3.eth.Contract(CONSTANTS.ABIS.RESERVE, reserveAddr)

  reserveContract.methods.conversionRatesContract().call((err, conversionRateAddr) => {
    if(err || !conversionRateAddr) return callback(err || "no conversion rate contract addr")

    const conversionRatesContract = new web3.eth.Contract(CONSTANTS.ABIS.CONVERSION_RATE, conversionRateAddr)

    return conversionRatesContract.methods.getListedTokens().call(callback)
  })
}

function getPermissionlessTokensList (reserveAddr, callback){
  const permisionLessContract = new web3.eth.Contract(CONSTANTS.ABIS.NONE_RESERVE, reserveAddr)
  
  return permisionLessContract.methods.contracts().call((err, result)=> {
    return callback(err, result && [result.token])
  })
}

function getTokenInfoFromNetwork (tokenAddr, callback){
  // contract.erc20Contract.methods
  return {
    name,
    decimals,
    address,
    symbol,
    isOfficial: false
  }

}

module.exports.getBlockTimestamp = getBlockTimestamp;
module.exports.getCoinPrice = getCoinPrice;

module.exports.getAllReserve = getAllReserve;
module.exports.getReserveType = getReserveType;

module.exports.getReserveTokensList = getReserveTokensList
module.exports.getPermissionlessTokensList = getPermissionlessTokensList
