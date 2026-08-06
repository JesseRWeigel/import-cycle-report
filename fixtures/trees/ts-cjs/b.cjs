const { hello } = require('./a.cjs');

exports.greet = () => `${hello()} there`;
