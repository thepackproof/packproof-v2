/**
 * Javascript implementation of basic PEM (Privacy Enhanced Mail) algorithms.
 *
 * See: RFC 1421.
 *
 * @author Dave Longley
 *
 * Copyright (c) 2013-2014 Digital Bazaar, Inc.
 *
 * A Forge PEM object has the following fields:
 *
 * type: identifies the type of message (eg: "RSA PRIVATE KEY").
 *
 * procType: identifies the type of processing performed on the message,
 *   it has two subfields: version and type, eg: 4,ENCRYPTED.
 *
 * contentDomain: identifies the type of content in the message, typically
 *   only uses the value: "RFC822".
 *
 * dekInfo: identifies the message encryption algorithm and mode and includes
 *   any parameters for the algorithm, it has two subfields: algorithm and
 *   parameters, eg: DES-CBC,F8143EDE5960C597.
 *
 * headers: contains all other PEM encapsulated headers -- where order is
 *   significant (for pairing data like recipient ID + key info).
 *
 * body: the binary-encoded body.
 */
var forge = require('./forge');
require('./util');

// shortcut for pem API
var pem = module.exports = forge.pem = forge.pem || {};

/**
 * Encodes (serializes) the given PEM object.
 *
 * @param msg the PEM message object to encode.
 * @param options the options to use:
 *          maxline the maximum characters per line for the body, (default: 64).
 *
 * @return the PEM-formatted string.
 */
pem.encode = function(msg, options) {
  options = options || {};
  var rval = '-----BEGIN ' + msg.type + '-----\r\n';

  // encode special headers
  var header;
  if(msg.procType) {
    header = {
      name: 'Proc-Type',
      values: [String(msg.procType.version), msg.procType.type]
    };
    rval += foldHeader(header);
  }
  if(msg.contentDomain) {
    header = {name: 'Content-Domain', values: [msg.contentDomain]};
    rval += foldHeader(header);
  }
  if(msg.dekInfo) {
    header = {name: 'DEK-Info', values: [msg.dekInfo.algorithm]};
    if(msg.dekInfo.parameters) {
      header.values.push(msg.dekInfo.parameters);
    }
    rval += foldHeader(header);
  }

  if(msg.headers) {
    // encode all other headers
    for(var i = 0; i < msg.headers.length; ++i) {
      rval += foldHeader(msg.headers[i]);
    }
  }

  // terminate header
  if(msg.procType) {
    rval += '\r\n';
  }

  // add body
  rval += forge.util.encode64(msg.body, options.maxline || 64) + '\r\n';

  rval += '-----END ' + msg.type + '-----\r\n';
  return rval;
};

/**
 * Decodes (deserializes) all PEM messages found in the given string.
 *
 * @param str the PEM-formatted string to decode.
 *
 * @return the PEM message objects in an array.
 */
pem.decode = function(str) {
  var rval = [];

  // PackProof: process disjoint BEGIN segments, never retry a backtracking
  // whole-message expression at each input offset. Later boundaries start a
  // line, so literal BEGIN text in ordinary or folded header values is retained.
  // Preserve RegExp.exec's historical string coercion (including Buffer input)
  // and its acceptance of text/whitespace before the first opening boundary.
  str = String(str);
  var firstBegin = str.indexOf('-----BEGIN ');
  var segments = firstBegin === -1 ? [] :
    str.slice(firstBegin).split(/(?:^|\n)-----BEGIN /);
  var rCRLF = /\r?\n/;
  var match;
  for(var mi = 1; mi < segments.length; ++mi) {
    var segment = segments[mi];
    var labelEnd = segment.indexOf('-----');
    if(labelEnd < 1) {
      continue;
    }
    var label = segment.slice(0, labelEnd);
    if(/[^A-Z0-9- ]/.test(label)) {
      continue;
    }
    var bodyStart = labelEnd + 5;
    // Retain the historical optional newline after the opening boundary.
    if(segment[bodyStart] === '\r') { ++bodyStart; }
    if(segment[bodyStart] === '\n') { ++bodyStart; }
    var end = segment.indexOf('-----END ' + label + '-----', bodyStart);
    if(end === -1) {
      continue;
    }
    var content = segment.slice(bodyStart, end);
    var headers = null;
    var body = content;
    var separator = /\r?\n\r?\n/.exec(content);
    var firstLineEnd = content.indexOf('\n');
    var firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
    if(separator && firstLine.indexOf(':') !== -1) {
      headers = content.slice(0, separator.index);
      body = content.slice(separator.index + separator[0].length);
      if(/[^\x21-\x7e\s]/.test(headers)) {
        continue;
      }
    }
    if(body.length === 0 || /[^:A-Za-z0-9+\/=\s]/.test(body)) {
      continue;
    }

    // accept "NEW CERTIFICATE REQUEST" as "CERTIFICATE REQUEST"
    // https://datatracker.ietf.org/doc/html/rfc7468#section-7
    var type = label;
    if(type === 'NEW CERTIFICATE REQUEST') {
      type = 'CERTIFICATE REQUEST';
    }

    var msg = {
      type: type,
      procType: null,
      contentDomain: null,
      dekInfo: null,
      headers: [],
      body: forge.util.decode64(body)
    };
    rval.push(msg);

    // no headers
    if(!headers) {
      continue;
    }

    // parse headers
    var lines = headers.split(rCRLF);
    var li = 0;
    while(li < lines.length) {
      // get line, trim any rhs whitespace
      var lineParts = [rtrim(lines[li])];

      // RFC2822 unfold any following folded lines
      for(var nl = li + 1; nl < lines.length; ++nl) {
        var next = lines[nl];
        if(!/\s/.test(next[0])) {
          break;
        }
        lineParts.push(next);
        li = nl;
      }

      // parse header
      match = parseHeader(lineParts.join(''));
      if(match) {
        var header = {name: match[1], values: []};
        var values = match[2].split(',');
        for(var vi = 0; vi < values.length; ++vi) {
          header.values.push(ltrim(values[vi]));
        }

        // Proc-Type must be the first header
        if(!msg.procType) {
          if(header.name !== 'Proc-Type') {
            throw new Error('Invalid PEM formatted message. The first ' +
              'encapsulated header must be "Proc-Type".');
          } else if(header.values.length !== 2) {
            throw new Error('Invalid PEM formatted message. The "Proc-Type" ' +
              'header must have two subfields.');
          }
          msg.procType = {version: values[0], type: values[1]};
        } else if(!msg.contentDomain && header.name === 'Content-Domain') {
          // special-case Content-Domain
          msg.contentDomain = values[0] || '';
        } else if(!msg.dekInfo && header.name === 'DEK-Info') {
          // special-case DEK-Info
          if(header.values.length === 0) {
            throw new Error('Invalid PEM formatted message. The "DEK-Info" ' +
              'header must have at least one subfield.');
          }
          msg.dekInfo = {algorithm: values[0], parameters: values[1] || null};
        } else {
          msg.headers.push(header);
        }
      } else {
        // Retain upstream's stop-on-unrecognized-header behavior.
        break;
      }

      ++li;
    }

    if(msg.procType === 'ENCRYPTED' && !msg.dekInfo) {
      throw new Error('Invalid PEM formatted message. The "DEK-Info" ' +
        'header must be present if "Proc-Type" is "ENCRYPTED".');
    }
  }

  if(rval.length === 0) {
    throw new Error('Invalid PEM formatted message.');
  }

  return rval;
};

function foldHeader(header) {
  var rval = header.name + ': ';

  // ensure values with CRLF are folded
  var values = [];
  var insertSpace = function(match, $1) {
    return ' ' + $1;
  };
  for(var i = 0; i < header.values.length; ++i) {
    values.push(header.values[i].replace(/^(\S+\r\n)/, insertSpace));
  }
  rval += values.join(',') + '\r\n';

  // do folding
  var length = 0;
  var candidate = -1;
  for(var i = 0; i < rval.length; ++i, ++length) {
    if(length > 65 && candidate !== -1) {
      var insert = rval[candidate];
      if(insert === ',') {
        ++candidate;
        rval = rval.substr(0, candidate) + '\r\n ' + rval.substr(candidate);
      } else {
        rval = rval.substr(0, candidate) +
          '\r\n' + insert + rval.substr(candidate + 1);
      }
      length = (i - candidate - 1);
      candidate = -1;
      ++i;
    } else if(rval[i] === ' ' || rval[i] === '\t' || rval[i] === ',') {
      candidate = i;
    }
  }

  return rval;
}

function ltrim(str) {
  return str.replace(/^\s+/, '');
}

// Single-character tests and monotonic indices avoid polynomial regex retries
// on very long malformed or whitespace-heavy encapsulated headers.
function rtrim(str) {
  var end = str.length;
  while(end > 0 && /\s/.test(str[end - 1])) { --end; }
  return str.slice(0, end);
}

function parseHeader(line) {
  var colon = line.indexOf(':');
  if(colon < 1) { return null; }
  var name = line.slice(0, colon);
  var value = line.slice(colon + 1);
  if(/[^\x21-\x7e]/.test(name) || value.length === 0 ||
    /[^\x21-\x7e\s]/.test(value)) {
    return null;
  }
  return [line, name, ltrim(value)];
}
