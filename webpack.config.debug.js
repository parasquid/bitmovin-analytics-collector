const path = require('path');
const webpack = require('webpack');
const packageProperties = require('./package.json');

const {banner, entry, externals, loaders, getGitVersion} = require('./webpack.config.js');

module.exports = {
  entry,
  externals,
  output: {
    path: path.resolve('./build/debug'),
    // for dev-server
    publicPath: '/build/debug',
    filename: 'bitmovinanalytics.min.js',
    libraryTarget: 'umd'
  },
  module: {
    loaders
  },
  plugins: [
    new webpack.BannerPlugin(banner),
    new webpack.DefinePlugin({
      __VERSION__: JSON.stringify(getGitVersion())
    })
  ],
  devtool: 'inline-source-map'
};
