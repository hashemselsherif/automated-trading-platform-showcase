// logger.js
module.exports = (ev, fields={}) => {
  console.log(JSON.stringify({ts:new Date().toISOString(),ev,...fields}));
};

