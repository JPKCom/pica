// High speed resize with tuneable speed/quality ratio

'use strict';


var unsharp = require('./unsharp');


// Precision of fixed FP values
var FIXED_FRAC_BITS = 14;
var FIXED_FRAC_VAL  = 1 << FIXED_FRAC_BITS;


//
// Presets for quality 0..3. Filter functions + window size
//
var FILTER_INFO = [
  { // Nearest neibor (Box)
    win: 0.5,
    filter: function (x) {
      return (x >= -0.5 && x < 0.5) ? 1.0 : 0.0;
    }
  },
  { // Hamming
    win: 1.0,
    filter: function (x) {
      if (x <= -1.0 || x >= 1.0) { return 0.0; }
      if (x > -1.19209290E-07 && x < 1.19209290E-07) { return 1.0; }
      var xpi = x * Math.PI;
      return ((Math.sin(xpi) / xpi) *  (0.54 + 0.46 * Math.cos(xpi / 1.0)));
    }
  },
  { // Lanczos, win = 2
    win: 2.0,
    filter: function (x) {
      if (x <= -2.0 || x >= 2.0) { return 0.0; }
      if (x > -1.19209290E-07 && x < 1.19209290E-07) { return 1.0; }
      var xpi = x * Math.PI;
      return (Math.sin(xpi) / xpi) * Math.sin(xpi / 2.0) / (xpi / 2.0);
    }
  },
  { // Lanczos, win = 3
    win: 3.0,
    filter: function (x) {
      if (x <= -3.0 || x >= 3.0) { return 0.0; }
      if (x > -1.19209290E-07 && x < 1.19209290E-07) { return 1.0; }
      var xpi = x * Math.PI;
      return (Math.sin(xpi) / xpi) * Math.sin(xpi / 3.0) / (xpi / 3.0);
    }
  }
];

function clampTo8(i) { return i < 0 ? 0 : (i > 255 ? 255 : i); }

function toFixedPoint(num) { return Math.floor(num * FIXED_FRAC_VAL); }


// Calculate convolution filters for each destination point,
// and pack data to Int16Array:
//
// [ shift, length, data..., shift2, length2, data..., ... ]
//
// - shift - offset in src image
// - length - filter length (in src points)
// - data - filter values sequence
//
function createFilters(quality, srcSize, destSize) {

  var filterFunction = FILTER_INFO[quality].filter;

  var scale         = destSize / srcSize;
  var scaleInverted = 1.0 / scale;
  var scaleClamped  = Math.min(1.0, scale); // For upscale

  // Filter window (averaging interval), scaled to src image
  var srcWindow = FILTER_INFO[quality].win / scaleClamped;

  var destPixel, srcPixel, srcFirst, srcLast, filterElementSize,
      floatFilter, fxpFilter, total, fixedTotal, pxl, idx, floatVal, fixedVal;
  var leftNotEmpty, rightNotEmpty, filterShift, filterSize;

  var maxFilterElementSize = Math.floor((srcWindow + 1) * 2 );
  var packedFilter    = new Int16Array((maxFilterElementSize + 2) * destSize);
  var packedFilterPtr = 0;

  // For each destination pixel calculate source range and built filter values
  for (destPixel = 0; destPixel < destSize; destPixel++) {

    // Scaling should be done relative to central pixel point
    srcPixel = (destPixel + 0.5) * scaleInverted;

    srcFirst = Math.max(0, Math.floor(srcPixel - srcWindow));
    srcLast  = Math.min(srcSize - 1, Math.ceil(srcPixel + srcWindow));

    filterElementSize = srcLast - srcFirst + 1;
    floatFilter = new Float32Array(filterElementSize);
    fxpFilter = new Int16Array(filterElementSize);

    total = 0.0;

    // Fill filter values for calculated range
    for (pxl = srcFirst, idx = 0; pxl <= srcLast; pxl++, idx++) {
      floatVal = filterFunction(((pxl + 0.5) - srcPixel) * scaleClamped);
      total += floatVal;
      floatFilter[idx] = floatVal;
    }

    // Normalize filter, convert to fixed point and accumulate conversion error
    fixedTotal = 0;

    for (idx = 0; idx < floatFilter.length; idx++) {
      fixedVal = toFixedPoint(floatFilter[idx] / total);
      fixedTotal += fixedVal;
      fxpFilter[idx] = fixedVal;
    }

    // Compensate normalization error, to minimize brightness drift
    fxpFilter[destSize >> 1] += toFixedPoint(1.0) - fixedTotal;

    //
    // Now pack filter to useable form
    //
    // 1. Trim heading and tailing zero values, and compensate shitf/length
    // 2. Put all to single array in this format:
    //
    //    [ pos shift, data length, value1, value2, value3, ... ]
    //

    leftNotEmpty = 0;
    while (leftNotEmpty < fxpFilter.length && fxpFilter[leftNotEmpty] === 0) {
      leftNotEmpty++;
    }

    if (leftNotEmpty < fxpFilter.length) {
      rightNotEmpty = fxpFilter.length - 1;
      while (rightNotEmpty > 0 && fxpFilter[rightNotEmpty] === 0) {
        rightNotEmpty--;
      }

      filterShift = srcFirst + leftNotEmpty;
      filterSize = rightNotEmpty - leftNotEmpty + 1;

      packedFilter[packedFilterPtr++] = filterShift; // shift
      packedFilter[packedFilterPtr++] = filterSize; // size

      packedFilter.set(fxpFilter.subarray(leftNotEmpty, rightNotEmpty + 1), packedFilterPtr);
      packedFilterPtr += filterSize;
    } else {
      // zero data, write header only
      packedFilter[packedFilterPtr++] = 0; // shift
      packedFilter[packedFilterPtr++] = 0; // size
    }
  }
  return packedFilter;
}


function convolveHorizontally(src, dest, srcW, srcH, destW, destH, filters) {

  var r, g, b, a;
  var filterPtr, filterShift, filterSize;
  var srcPtr, srcY, destX, filterVal;
  var srcOffset = 0, destOffset = 0;

  // For each row
  for (srcY = 0; srcY < srcH; srcY++) {
    filterPtr  = 0;

    // Apply precomputed filters to each destination row point
    for (destX = 0; destX < destW; destX++) {
      // Get the filter that determines the current output pixel.
      filterShift     = filters[filterPtr++];
      filterSize      = filters[filterPtr++];

      srcPtr = (srcOffset + (filterShift * 4))|0;

      r = g = b = a = 0;

      // Apply the filter to the row to get the destination pixel r, g, b, a
      for (; filterSize > 0; filterSize--) {
        filterVal = filters[filterPtr++];

        // Use reverse order to workaround deopts in old v8 (node v.10)
        // Big thanks to @mraleph (Vyacheslav Egorov) for the tip.
        a = (a + filterVal * src[srcPtr + 3])|0;
        b = (b + filterVal * src[srcPtr + 2])|0;
        g = (g + filterVal * src[srcPtr + 1])|0;
        r = (r + filterVal * src[srcPtr])|0;
        srcPtr = (srcPtr + 4)|0;
      }

      // Bring this value back in range. All of the filter scaling factors
      // are in fixed point with FIXED_FRAC_BITS bits of fractional part.
      dest[destOffset++] = clampTo8((r|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((g|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((b|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((a|0) >> 14/*FIXED_FRAC_BITS*/);
    }

    srcOffset += srcW * 4;
  }
}


function convolveVertically(src, dest, srcW, srcH, destW, destH, filters, withAlpha) {
  var r, g, b, a;
  var filterPtr, filterShift, filterSize;
  var srcPtr, srcX, destY, filterVal;
  var srcOffset = 0, destOffset = 0;

  // For each row
  for (srcX = 0; srcX < destW; srcX++) {
    filterPtr  = 0;

    // Apply precomputed filters to each destination row point
    for (destY = 0; destY < destH; destY++) {
      // Get the filter that determines the current output pixel.
      filterShift     = filters[filterPtr++];
      filterSize      = filters[filterPtr++];

      srcPtr = (srcOffset + (filterShift * destW * 4))|0;

      r = g = b = a = 0;

      // Apply the filter to the row to get the destination pixel r, g, b, a
      for (; filterSize > 0; filterSize--) {
        filterVal = filters[filterPtr++];

        // Use reverse order to workaround deopts in old v8 (node v.10)
        // Big thanks to @mraleph (Vyacheslav Egorov) for the tip.
        if (withAlpha) { a = (a + filterVal * src[srcPtr + 3])|0; }
        b = (b + filterVal * src[srcPtr + 2])|0;
        g = (g + filterVal * src[srcPtr + 1])|0;
        r = (r + filterVal * src[srcPtr])|0;
        srcPtr = (srcPtr + destW * 4)|0;
      }

      // Bring this value back in range. All of the filter scaling factors
      // are in fixed point with FIXED_FRAC_BITS bits of fractional part.
      dest[destOffset++] = clampTo8((r|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((g|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((b|0) >> 14/*FIXED_FRAC_BITS*/);
      if (withAlpha) {
        // Fix alpha channel if become wrong due rounding errors.
        // It can't be smaller than any color channel.
        // Operate with unshifted values for simplicity
        if (a < r) { a = r; }
        if (a < g) { a = g; }
        if (a < b) { a = b; }

        dest[destOffset] = clampTo8((a|0) >> 14/*FIXED_FRAC_BITS*/);
      } else {
        dest[destOffset] = 0xff;
      }
      destOffset += destW * 4 - 3;
    }

    srcOffset += 4;
    destOffset = srcOffset;
  }
}


function resize(options) {
  var src   = options.src;
  var srcW  = options.width;
  var srcH  = options.height;
  var destW = options.toWidth;
  var destH = options.toHeight;
  var dest  = options.dest || new Uint8Array(destW * destH * 4);
  var quality = options.quality === undefined ? 3 : options.quality;
  var alpha = options.alpha || false;
  var unsharpAmount = options.unsharpAmount === undefined ? 0 : (options.unsharpAmount|0);
  var unsharpThreshold = options.unsharpThreshold === undefined ? 0 : (options.unsharpThreshold|0);

  if (srcW < 1 || srcH < 1 || destW < 1 || destH < 1) { return []; }

  var filtersX = createFilters(quality, srcW, destW),
      filtersY = createFilters(quality, srcH, destH);

  var tmp  = new Uint8Array(destW * srcH * 4);

  convolveHorizontally(src, tmp, srcW, srcH, destW, destH, filtersX);
  convolveVertically(tmp, dest, destW, srcH, destW, destH, filtersY, alpha);

  if (unsharpAmount) {
    unsharp(dest, destW, destH, unsharpAmount, 1.0, unsharpThreshold);
  }

  return dest;
}


module.exports = resize;
