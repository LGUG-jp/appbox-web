/* Inspect PNG / JPEG / WebP headers before allocating decoded image pixels. */
(() => {
  "use strict";
  const invalid = () => new Error("PNG・JPEG・WebP画像のヘッダーが不正か、途中で切れています。");
  const unsupported = () => new Error("PNG・JPEG・WebP形式の画像を選択してください。");
  const uint16 = (b, i) => b[i] | (b[i+1] << 8);
  const uint24 = (b, i) => b[i] | (b[i+1] << 8) | (b[i+2] << 16);
  const uint32 = (b, i) => b[i] + b[i+1]*256 + b[i+2]*65536 + b[i+3]*16777216;
  const big32 = (b, i) => b[i]*16777216 + b[i+1]*65536 + b[i+2]*256 + b[i+3];
  const tag = (b, i, text) => [...text].every((c, j) => b[i+j] === c.charCodeAt(0));

  // Verify encoded frames too: a VP8X canvas may understate their size.
  function webpBitstream(bytes,name,pos,length) {
    if(name==="VP8 "){
      if(length<10 || (bytes[pos]&1)!==0 || bytes[pos+3]!==0x9d || bytes[pos+4]!==1 || bytes[pos+5]!==0x2a) throw invalid();
      return {width:uint16(bytes,pos+6)&0x3fff,height:uint16(bytes,pos+8)&0x3fff};
    }
    if(name==="VP8L"){
      if(length<5 || bytes[pos]!==0x2f || (bytes[pos+4]&0xe0)!==0) throw invalid();
      return {width:1+(bytes[pos+1]|((bytes[pos+2]&63)<<8)),
        height:1+((bytes[pos+2]>>6)|(bytes[pos+3]<<2)|((bytes[pos+4]&15)<<10))};
    }
    throw invalid();
  }
  function walkWebpChunks(bytes,start,end,visit) {
    for(let i=start;i<end;){
      if(i+8>end) throw invalid();
      const length=uint32(bytes,i+4), pos=i+8;
      if(length>end-pos || length+(length&1)>end-pos) throw invalid();
      visit(String.fromCharCode(...bytes.subarray(i,i+4)),pos,length);
      i=pos+length+(length&1);
    }
  }
  function dimensions(bytes, {allowAnimation = false} = {}) {
    if (!(bytes instanceof Uint8Array)) throw invalid();
    let width, height, mime;
    if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
      if (bytes.length < 33 || big32(bytes, 8) !== 13 || !tag(bytes, 12, "IHDR")) throw invalid();
      width = big32(bytes, 16);height = big32(bytes, 20);
      const depth = bytes[24], color = bytes[25];
      const depths = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) throw invalid();
      mime = "image/png";
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i < bytes.length) {
        if (bytes[i++] !== 0xff) throw invalid();
        while (i < bytes.length && bytes[i] === 0xff) i++;
        if (i >= bytes.length) throw invalid();
        const marker = bytes[i++];
        if (marker === 0xd9 || marker === 0xda || marker === 0x00) throw invalid();
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (i + 2 > bytes.length) throw invalid();
        const length = bytes[i]*256 + bytes[i+1];
        if (length < 2 || i + length > bytes.length) throw invalid();
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) {
          if (length < 8) throw invalid();
          height = bytes[i+3]*256 + bytes[i+4];width = bytes[i+5]*256 + bytes[i+6];
          mime = "image/jpeg";break;
        }
        i += length;
      }
      if (!mime) throw invalid();
    } else if (bytes.length >= 12 && tag(bytes, 0, "RIFF") && tag(bytes, 8, "WEBP")) {
      if(uint32(bytes,4)+8!==bytes.length || bytes.length<20) throw invalid();
      const length=uint32(bytes,16), pos=20;
      if(length>bytes.length-pos || length+(length&1)>bytes.length-pos) throw invalid();
      if(tag(bytes,12,"VP8 ") || tag(bytes,12,"VP8L")){
        ({width,height}=webpBitstream(bytes,tag(bytes,12,"VP8 ")?"VP8 ":"VP8L",pos,length));
      }else if(tag(bytes,12,"VP8X")){
        if(length!==10 || bytes[pos+1]!==0 || bytes[pos+2]!==0 || bytes[pos+3]!==0) throw invalid();
        const animated=(bytes[pos]&0x02)!==0;
        if(animated && !allowAnimation) throw invalid();
        width=1+uint24(bytes,pos+4);height=1+uint24(bytes,pos+7);
        let images=0,frames=0;
        walkWebpChunks(bytes,30,bytes.length,(name,chunk,size)=>{
          if(name==="VP8 " || name==="VP8L"){
            if(animated) throw invalid();
            const coded=webpBitstream(bytes,name,chunk,size);
            if(coded.width!==width || coded.height!==height) throw invalid();
            images++;
          }else if(name==="ANMF"){
            if(!animated || size<16) throw invalid();
            const x=2*uint24(bytes,chunk), y=2*uint24(bytes,chunk+3);
            const frameWidth=1+uint24(bytes,chunk+6),frameHeight=1+uint24(bytes,chunk+9);
            if(x+frameWidth>width || y+frameHeight>height) throw invalid();
            let frameImages=0;
            walkWebpChunks(bytes,chunk+16,chunk+size,(kind,part,n)=>{
              if(kind==="VP8 " || kind==="VP8L"){
                const coded=webpBitstream(bytes,kind,part,n);
                if(coded.width!==frameWidth || coded.height!==frameHeight) throw invalid();
                frameImages++;
              }
            });
            if(frameImages!==1) throw invalid();
            frames++;
          }
        });
        if(animated ? frames===0 || images!==0 : images!==1 || frames!==0) throw invalid();
      }else throw invalid();
      mime="image/webp";
    } else throw unsupported();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw invalid();
    return {width, height, mime};
  }
  async function readDimensions(file, options) {
    if (!file || typeof file.arrayBuffer !== "function") throw invalid();
    // Callers enforce their 25MiB / 5MiB compressed-byte limits before this read.
    return dimensions(new Uint8Array(await file.arrayBuffer()), options);
  }
  function assertDimensions(header, width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !((width === header.width && height === header.height) ||
          (["image/jpeg", "image/png"].includes(header.mime) && width === header.height && height === header.width))) {
      // JPEG EXIF / PNG eXIf rotation may swap the axes without changing the pixel count.
      throw new Error("画像ヘッダーと実際の画像サイズが一致しません。");
    }
  }
  const api = Object.freeze({dimensions, readDimensions, assertDimensions});
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.AppBoxSafeImage = api;
})();
