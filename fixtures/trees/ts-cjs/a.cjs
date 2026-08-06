const { greet } = require('./b.cjs');

exports.hello = () => 'hi';
exports.banner = greet();
