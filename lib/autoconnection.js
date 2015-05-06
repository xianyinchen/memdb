'use strict';

var _ = require('lodash');
var domain = require('domain');
var P = require('bluebird');
var Connection = require('./connection');
var logger = require('pomelo-logger').getLogger('memdb-client', __filename);

var DEFAULT_MAX_CONNECTION = 32;
var DEFAULT_CONNECTION_IDLE_TIMEOUT = 60 * 1000;
var DEFAULT_MAX_PENDING_TASK = 128;

// Use one separate connection in one execution scope (One connection per 'request')
var AutoConnection = function(opts){
	opts = opts || {};

	this.db = opts.db;

	this.config = {};
	this.config.maxConnection = opts.maxConnection || DEFAULT_MAX_CONNECTION;
	this.config.connectionIdleTimeout = opts.connectionIdleTimeout || DEFAULT_CONNECTION_IDLE_TIMEOUT;
	this.config.maxPendingTask = opts.maxPendingTask || DEFAULT_MAX_PENDING_TASK;
	this.config.host = opts.host;
	this.config.port = opts.port;

	this.connections = {}; // {connId : connection}
	this.freeConnections = {}; // {connId : true}
	this.connectionTimeouts = {}; // {connId : timeout}
	this.autoId = 0;

	this.pendingTasks = [];
};

var proto = AutoConnection.prototype;

proto.close = function(){
	return P.bind(this)
	.then(function(){
		return Object.keys(this.connections);
	})
	.map(function(connId){
		var conn = this.connections[connId];
		if(conn){
			return conn.close();
		}
	});
};

proto.openConnection = function(){
	if(Object.keys(this.connections).length >= this.config.maxConnection){
		return;
	}

	var connId = ++this.autoId;

	logger.info('open connection %s', connId);

	var conn = new Connection({
							db : this.db,
							host : this.config.host,
							port : this.config.port,
							idleTimeout : this.config.connectionIdleTimeout
						});
	this.connections[connId] = conn;

	return P.bind(this)
	.then(function(){
		return conn.connect();
	})
	.then(function(){
		this.freeConnections[connId] = true;

		var self = this;
		conn.on('close', function(){
			logger.info('connection %s closed', connId);
			delete self.connections[connId];
			delete self.freeConnections[connId];
		});

		setImmediate(this._runTask.bind(this));
	})
	.catch(function(e){
		logger.error(e.stack);
	});
};

// Execute func in a new connection
// Auto commit if execute without execption
proto.execute = function(func){
	if(this.pendingTasks.length >= this.config.maxPendingTask){
		throw new Error('Too much pending tasks');
	}

	var deferred = P.defer();
	this.pendingTasks.push({
		func : func,
		deferred : deferred
	});

	setImmediate(this._runTask.bind(this));

	return deferred.promise;
};

proto._runTask = function(){
	if(this.pendingTasks.length === 0){
		return;
	}
	var connIds = Object.keys(this.freeConnections);
	if(connIds.length === 0){
	 	return this.openConnection();
	}

	var connId = connIds[0];
	var conn = this.connections[connId];
	delete this.freeConnections[connId];

	var task = this.pendingTasks.splice(0, 1)[0];

	var scope = domain.create();
	scope.__memdbconn__ = connId;

	var self = this;
	scope.run(function(){
		logger.info('task start on connection %s', connId);

		var startTick = Date.now();
		P.bind(self)
		.then(function(){
			return task.func();
		})
		.then(function(ret){
			return P.try(function(){
				return conn.commit();
			})
			.then(function(){
				task.deferred.resolve(ret);
				logger.info('task done on connection %s (%sms)', connId, Date.now() - startTick);
			});
		}, function(err){
			return P.try(function(){
				return conn.rollback();
			})
			.then(function(){
				task.deferred.reject(err);
				logger.warn('task error on connection %s - %s', connId, err.message);
			});
		})
		.then(function(){
			if(!!this.connections[connId]){
				this.freeConnections[connId] = true;
			}

			setImmediate(this._runTask.bind(this));
		})
		.catch(function(e){
			logger.error(e.stack);
		});
	});
};

// Get connection from current scope
proto._connection = function(){
	var connectionId = process.domain ? process.domain.__memdbconn__ : null;

	if(!connectionId || !this.connections[connectionId]){
		throw new Error('You are not in any execution scope');
	}
	return this.connections[connectionId];
};

proto.collection = function(name){
	return this._connection().collection(name);
};

proto.commit = function(){
	return this._connection().commit();
};

proto.rollback = function(){
	return this._connection().rollback();
};

proto.persistentAll = function(){
	return this._connection().persistentAll();
};

module.exports = AutoConnection;