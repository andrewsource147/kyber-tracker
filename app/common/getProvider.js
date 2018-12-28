const getWeb3Instance = require('./getWeb3Instance');
const CONSTANTS = require('./Const')
const rpc = getWeb3Instance();

const erc20Contract = new this.rpc.eth.Contract(CONSTANTS.ABIS.ERC20)
const internalContract = new this.rpc.eth.Contract(CONSTANTS.ABIS.INTERNAL_NETWORK)
const reserveContract = new this.rpc.eth.Contract(CONSTANTS.ABIS.RESERVE)
const noneReserveContract = new this.rpc.eth.Contract(CONSTANTS.ABIS.ERC20)


module.exports = {
  erc20Contract,
  internalContract,
  reserveContract,
  noneReserveContract
}