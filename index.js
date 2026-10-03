'use strict';

const { LinksysVelopPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LinksysVelopPlatform);
};
