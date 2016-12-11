#!/usr/bin/env node

'use strict';

const Promise = require('bluebird');
const path = require('path');
const util = require('util');
const btoa = require('btoa');
const atob = require('atob');
const fs = Promise.promisifyAll(require('fs'));

const embedArr = [ 'textures', 'shaders', true ];
const embed = {};

const argv = require('yargs')
  .usage('Usage: $0 <file> [options]')
  .demand(1)
  .array('e')
  .describe('e', 'embeds textures or shaders into binary GLTF file')
  .choices('e', embedArr)
  .alias('e', 'embed')
  .boolean('cesium')
  .describe('cesium', 'sets the old body buffer name for compatibility with Cesium')
  .boolean('shaders')
  .describe('shaders', 'overrides the shades with built in ones')
  .help('h')
  .alias('h', 'help')
  .argv;

if (argv.embed) {
  // If just specified as --embed, embed all types into body.
  const arr = argv.embed.length ? argv.embed : embedArr;

  // Enable the specific type of resource to be embedded.
  arr.forEach(function (type) {
    embed[type] = true;
  });
}

const filename = argv._[0];
//const BUFFER_NAME = argv.cesium ? 'KHR_binary_glTF' : 'binary_glTF';
const BUFFER_NAME = argv.cesium ? 'binary_glTF' : 'binary_glTF';

const wantDefaultShader = argv.shaders ? true : false;

if (!filename.endsWith('.gltf')) {
  console.error('Failed to create binary GLTF file:');
  console.error('----------------------------------');
  console.error('File specified does not have the .gltf extension.');
  return;
}

// Lets us keep track of how large the body will be, as well as the offset for each of the
// original buffers.
let bodyLength = 0;
const bodyParts = [];

const base64Regexp = /^data:.*?;base64,/;
const containingFolder = path.dirname(filename);

function addToBody(uri) {
  let promise;
  if (uri.startsWith('data:')) {
    if (!base64Regexp.test(uri)) throw new Error('unsupported data URI');

    var uri2 = uri.replace(base64Regexp, '');
    var contentType = uri.split(';')[0].replace('data:','')
    if (contentType == 'text/plain') { 
      uri2 = uri2.toString('utf-8');
      //console.log(uri2);
    }

    var b = new Buffer(uri2, 'base64');
    promise = Promise.resolve(b);
  }
  else promise = fs.readFileAsync(path.join(containingFolder, uri));

  return promise.then(function (contents) {
    const offset = bodyLength;
    bodyParts.push(offset, contents);
    const length = contents.length;
    bodyLength += length;
    return { offset, length };
  });
}

function alterMaterial(matl, ext) {
  let promise;

  matl.extensions =  ext;

  promise = Promise.resolve(matl);

  return promise.then(function (matl) {
    return matl;
  });
}

function defaultShaders() {
  var s = {
    vertexShader: `// Create VS

precision highp float;

attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec3 a_batchId;
varying vec3 v_normal;
uniform mat4 u_modelViewMatrix;
uniform mat4 u_projectionMatrix;
uniform mat3 u_normalMatrix;

void main(void) {
  v_normal = u_normalMatrix * a_normal;

  vec4 pos;
  pos = u_modelViewMatrix * vec4(a_position,1.0);
  gl_Position = u_projectionMatrix * pos;
}

`,
    featureShader: `// Create FS

precision highp float;
uniform vec4 u_ambient;
uniform vec4 u_diffuse;
uniform vec4 u_emission;
uniform vec4 u_specular;
uniform float u_shininess;
uniform float u_transparency; 

varying vec3 v_position;
varying vec3 v_normal;

void main(void) {
vec3 normal = normalize(v_normal);
if (gl_FrontFacing == false) normal = -normal;
vec4 color = vec4(0., 0., 0., 0.);
vec4 diffuse = vec4(0., 0., 0., 1.);
vec3 diffuseLight = vec3(0., 0., 0.);
vec4 emission;
vec4 ambient;
vec4 specular;

ambient = u_ambient;
diffuse = u_diffuse;
emission = u_emission;
specular = u_specular;

color.xyz += specular.xyz;
// brighten only
diffuse.xyz *= max(dot(normal,vec3(0.,0.,1.)), 0.); 
color.xyz += diffuse.xyz;
color.xyz += emission.xyz;
color = vec4(color.rgb * diffuse.a, diffuse.a * u_transparency);
gl_FragColor = color;
}
`
  }
  return s;
}

fs.readFileAsync(filename, 'utf-8').then(function (gltf) {
  // Modify the GLTF data to reference the buffer in the body instead of external references.
  const scene = JSON.parse(gltf);

  // Let a GLTF parser know that it is using the Binary GLTF extension.
  if (Array.isArray(scene.extensionsUsed)) scene.extensionsUsed.push('KHR_binary_glTF');
  else scene.extensionsUsed = [ 'KHR_binary_glTF' ];

  const bufferPromises = [];
  Object.keys(scene.buffers).forEach(function (bufferId) {
    const buffer = scene.buffers[bufferId];

    // We don't know how to deal with other types of buffers yet.
    const type = buffer.type;

    if (type && type !== 'arraybuffer') {
      throw new Error(util.format('buffer type "%s" not supported: %s', type, bufferId));
    }

    const promise = addToBody(buffer.uri).then(function (obj) {
      // Set the buffer value to the offset temporarily for easier manipulation of bufferViews.
      buffer.byteOffset = obj.offset;
    });

    bufferPromises.push(promise);
  });

  // Run this on the existing buffers first so that the buffer view code can read from it.
  return Promise.all(bufferPromises).return(scene);
}).then(function (scene) {
  Object.keys(scene.bufferViews).forEach(function (bufferViewId) {
    const bufferView = scene.bufferViews[bufferViewId];
    const bufferId = bufferView.buffer;
    const referencedBuffer = scene.buffers[bufferId];

    if (!referencedBuffer) {
      throw new Error(util.format('buffer ID reference not found: %s', bufferId));
    }

    bufferView.buffer = BUFFER_NAME;
    bufferView.byteOffset += referencedBuffer.byteOffset;
  });

  const promises = [];
  if (embed.shaders && scene.shaders) Object.keys(scene.shaders).forEach(function (shaderId) {
    const shader = scene.shaders[shaderId];
    const uri = shader.uri;
    shader.uri = '';
    var urx;

    if (wantDefaultShader == true) {
      console.log("overriding provided shaders, if any");
      var s = defaultShaders();
      if (shaderId == 'd0FS')  { urx = 'data:text/plain;base64,' + btoa(s.featureShader); }
      else if (shaderId == 'd0VS')  { urx = 'data:text/plain;base64,' + btoa(s.vertexShader); }
      else { 
 	console.log("ShaderId: " + shaderId + " is not well known" );
        if (shaderId.endsWith('FS')) { 
            urx = 'data:text/plain;base64,' + btoa(s.featureShader);
        } else if (shaderId.endsWith('VS')) {
            urx = 'data:text/plain;base64,' + btoa(s.vertexShader);
        } else {
            urx = uri;
        }
      }
      /*console.log(shaderId);
      var fS = atob(urx.replace('data:text/plain;base64,',''));
      console.log(fS + "\n");
      */
    } else {
      urx = uri;
      //var fS = atob(urx.replace('data:text/plain;base64,',''));
      //console.log(fS + "\n");
    }
    const promise = addToBody(urx).then(function (obj) {
      const bufferViewId = 'binary_shader_' + shaderId;
      shader.extensions = { KHR_binary_glTF: { bufferView: bufferViewId } };

      scene.bufferViews[bufferViewId] =
        { buffer: BUFFER_NAME
        , byteLength: obj.length
        , byteOffset: obj.offset
        };
    });

    promises.push(promise);

  });

  // TODO: embed images into body (especially if already embedded as base64)
  if (scene.images) Object.keys(scene.images).forEach(function (imageId) {
    const image = scene.images[imageId];
    const uri = image.uri;

    const promise = addToBody(uri).then(function (obj) {
      const bufferViewId = 'binary_images_' + imageId;
      // TODO: add extension properties
      image.extensions =
        { KHR_binary_glTF:
          { bufferView: bufferViewId
          , mimeType: 'image/i-dont-know'
          , height: 9999
          , width: 9999
          }
        };

      scene.bufferViews[bufferViewId] =
        { buffer: BUFFER_NAME
        , byteLength: obj.length
        , byteOffset: obj.offset
        };
    });

    promises.push(promise);
  });

  //
  // TODO: embed images into body (especially if already embedded as base64)
  if (scene.images) Object.keys(scene.images).forEach(function (imageId) {
    const image = scene.images[imageId];
    const uri = image.uri;

    const promise = addToBody(uri).then(function (obj) {
      const bufferViewId = 'binary_images_' + imageId;
      // TODO: add extension properties
      image.extensions =
        { KHR_binary_glTF:
          { bufferView: bufferViewId
          , mimeType: 'image/i-dont-know'
          , height: 9999
          , width: 9999
          }
        };

      scene.bufferViews[bufferViewId] =
        { buffer: BUFFER_NAME
        , byteLength: obj.length
        , byteOffset: obj.offset
        };
    });

    promises.push(promise);
  });


  return Promise.all(promises).return(scene);
}).then(function (scene) {

  // Cesium seems to run into issues if this is not defined, even though it shouldn't be needed.
  scene.buffers =
    { binary_glTF:
      { uri: 'data'
      , byteLength: bodyLength
      }
    };

  const newSceneStr = JSON.stringify(scene);
  const sceneLength = Buffer.byteLength(newSceneStr);
  // As body is 4-byte aligned, the scene length must be padded to have a multiple of 4.
  // jshint bitwise:false
  const paddedSceneLength = (sceneLength + 3) & ~3;
  // jshint bitwise:true

  // Header is 20 bytes long.
  const bodyOffset = paddedSceneLength + 20;
  const fileLength = bodyOffset + bodyLength;

  // Let's create our GLB file!
  const glbFile = new Buffer(fileLength);

  // Magic number (the ASCII string 'glTF').
  glbFile.writeUInt32BE(0x676C5446, 0);

  // Binary GLTF is little endian.
  // Version of the Binary glTF container format as a uint32 (vesrion 1).
  glbFile.writeUInt32LE(1, 4);

  // Total length of the generated file in bytes (uint32).
  glbFile.writeUInt32LE(fileLength, 8);

  // Total length of the scene in bytes (uint32).
  glbFile.writeUInt32LE(paddedSceneLength, 12);

  // Scene format as a uint32 (JSON is 0).
  glbFile.writeUInt32LE(0, 16);

  // Write the scene.
  glbFile.write(newSceneStr, 20);

  // Add spaces as padding to ensure scene is a multiple of 4 bytes.
  for (let i = sceneLength + 20; i < bodyOffset; ++i) glbFile[i] = 0x20;

  // Write the body.
  for (let i = 0; i < bodyParts.length; i += 2) {
    const offset = bodyParts[i];
    const contents = bodyParts[i + 1];
    contents.copy(glbFile, bodyOffset + offset);
  }

  return fs.writeFileAsync(filename.replace(/\.gltf$/, '.glb'), glbFile);
}).error(function (error) {
  console.error('Failed to create binary GLTF file:');
  console.error('----------------------------------');
  console.error(error);
});
