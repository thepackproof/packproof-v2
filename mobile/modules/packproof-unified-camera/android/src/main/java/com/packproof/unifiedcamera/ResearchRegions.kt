package com.packproof.unifiedcamera

/** Existing decoder geometry only. No shipping/item/serial identity is inferred from a barcode. */
object ResearchRegions {
  fun nativeBounds(rotated: IntArray, width: Int, height: Int, rotation: Int): IntArray? {
    if(rotated.size != 4 || width < 2 || height < 2) return null
    val l=rotated[0]; val t=rotated[1]; val r=rotated[2]; val b=rotated[3]
    val bounds=when(rotation) {
      0 -> intArrayOf(l,t,r,b)
      90 -> intArrayOf(t,height-r,b,height-l)
      180 -> intArrayOf(width-r,height-b,width-l,height-t)
      270 -> intArrayOf(width-b,l,width-t,r)
      else -> return null
    }
    return bounds.takeIf { it[0]>=0 && it[1]>=0 && it[2]<=width && it[3]<=height && it[2]-it[0]>=4 && it[3]-it[1]>=4 }
  }
  fun quality(luma:ByteArray,width:Int,height:Int,bounds:IntArray):Map<String,Double> {
    require(luma.size==width*height && bounds.size==4)
    val step=maxOf(1,minOf(bounds[2]-bounds[0],bounds[3]-bounds[1])/48)
    var sum=0.0;var sharp=0.0;var saturated=0;var count=0
    for(y in bounds[1]+step until bounds[3] step step)for(x in bounds[0]+step until bounds[2] step step){
      val value=luma[y*width+x].toInt() and 255;val previous=luma[y*width+x-step].toInt() and 255
      sum+=value;sharp+=kotlin.math.abs(value-previous);if(value<8||value>247)saturated++;count++
    }
    require(count>0);return mapOf("meanLuma" to sum/count,"sharpness" to sharp/count,"saturationFraction" to saturated.toDouble()/count)
  }
}
