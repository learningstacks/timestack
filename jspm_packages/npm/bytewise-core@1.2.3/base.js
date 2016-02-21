/* */ 
var base = require('typewise-core/base');
var codecs = require('./codecs');
var util = require('./util');
base.bound.encode = util.encodeBaseBound;
var sorts = base.sorts;
sorts.void.byte = 0xf0;
sorts.null.byte = 0x10;
var BOOLEAN = sorts.boolean;
BOOLEAN.sorts.false.byte = 0x20;
BOOLEAN.sorts.true.byte = 0x21;
BOOLEAN.bound.encode = util.encodeBound;
var NUMBER = sorts.number;
NUMBER.sorts.min.byte = 0x40;
NUMBER.sorts.negative.byte = 0x41;
NUMBER.sorts.positive.byte = 0x42;
NUMBER.sorts.max.byte = 0x43;
NUMBER.sorts.negative.codec = codecs.NEGATIVE_FLOAT;
NUMBER.sorts.positive.codec = codecs.POSITIVE_FLOAT;
NUMBER.bound.encode = util.encodeBound;
var DATE = sorts.date;
DATE.sorts.negative.byte = 0x51;
DATE.sorts.positive.byte = 0x52;
DATE.sorts.negative.codec = codecs.PRE_EPOCH_DATE;
DATE.sorts.positive.codec = codecs.POST_EPOCH_DATE;
DATE.bound.encode = util.encodeBound;
var BINARY = sorts.binary;
BINARY.byte = 0x60;
BINARY.codec = codecs.UINT8;
BINARY.bound.encode = util.encodeBound;
var STRING = sorts.string;
STRING.byte = 0x70;
STRING.codec = codecs.UTF8;
STRING.bound.encode = util.encodeBound;
var ARRAY = sorts.array;
ARRAY.byte = 0xa0;
ARRAY.codec = codecs.LIST;
ARRAY.bound.encode = util.encodeListBound;
module.exports = base;