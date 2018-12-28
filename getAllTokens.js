const async     = require('async');
const _         = require('lodash');
require('dotenv').config();



console.log("++++++++", process.env.NODE_ENV)
const getAllReserve                     = require('./app/crawlers/leveldbCache').getAllReserve;
const getReserveType                    = require('./app/crawlers/leveldbCache').getReserveType;

const getReserveTokensList              = require('./app/crawlers/leveldbCache').getReserveTokensList;
const getPermissionlessTokensList       = require('./app/crawlers/leveldbCache').getPermissionlessTokensList;

const getTokenInfo         = require('./app/crawlers/leveldbCache').getTokenInfo;


getAllReserve((err, arrayReserve) => {
  //[ '0x975b54A3F8036DA7E96b570f39E5B09cd625a4D5',
  // '0x82a428804514ECef24879c2fF24718F08a55cDcC',
  // '0xEB52Ce516a8d054A574905BDc3D4a176D3a2d51a' ]
  console.log("list all reserve ", err, arrayReserve)
  if(err){
    console.log(err)
  }


  async.parallelLimit(arrayReserve.map(r => (asyncCallback) =>  getReserveType(r, asyncCallback)) , 10,
  (err, arrayTypeOfReserve) => {
    console.log("______________ all reserve type", err, arrayTypeOfReserve)

    // [ '2', '2', '1' ]
    async.parallelLimit(
      arrayTypeOfReserve.map((t, i) => (next) => {
        if(t == '1'){
          // none
          getReserveTokensList(arrayReserve[i], (err, arrayTokens) => next(err, 
            arrayTokens.map(t => ({
              reserveAddr: arrayReserve[i],
              type: '1',
              tokenAddr: t
            }))
          ))
        }
        if(t == '2'){
          // permissionless
          getPermissionlessTokensList(arrayReserve[i], (err, arrayTokens) => next(err,
            arrayTokens.map(t => ({
              reserveAddr: arrayReserve[i],
              type: '2',
              tokenAddr: t
            }))
          ))
        }
      }), 10, (err, tokensAddr) => {
        const allTokens = _.flatten(tokensAddr)
        if(err){
          console.log(err)
        }

        async.parallelLimit(
          allTokens.map(t => next => getTokenInfo(t.tokenAddr, t.type, (err, info) => next(err, {...t, info}))),
          10,
          (err, allTokenWithInfo) => {
            console.log("******************* all token data", allTokenWithInfo)
          }
        )
      }
    )

  })
})
