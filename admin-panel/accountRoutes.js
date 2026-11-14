'use strict';
function globalAdminRoute(path) { return /^\/api\/(?:accounts(?:\/|$)|auth\/context$|login$|logout$|operator\/)/.test(path.split('?')[0]); }
function instanceAdminRoute(path) { return ['/api/config','/api/status','/api/monitoring/health','/api/product-analytics','/api/product-analytics/targets','/api/product-analytics/review'].includes(path.split('?')[0]); }
module.exports={globalAdminRoute,instanceAdminRoute};
