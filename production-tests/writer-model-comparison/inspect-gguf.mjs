import fs from 'node:fs';
const file=process.argv[2];
const fd=fs.openSync(file,'r');
let pos=24;
function read(n){const b=Buffer.alloc(n);const r=fs.readSync(fd,b,0,n,pos);if(r!==n)throw Error('Unexpected EOF');pos+=n;return b;}
function u32(){return read(4).readUInt32LE(0)}
function u64(){return Number(read(8).readBigUInt64LE(0))}
function str(){const n=u64();const b=read(n);return b.toString('utf8')}
const magic=readAt(file,0,4).toString('ascii');
const version=readAt(file,4,4).readUInt32LE(0);
const tensorCount=Number(readAt(file,8,8).readBigUInt64LE(0));
const count=Number(readAt(file,16,8).readBigUInt64LE(0));
const result={magic,version,tensorCount,metadataCount:count};
const sizes={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
for(let i=0;i<count;i++){
  const key=str(),type=u32();
  if(type===8){const value=str();if(key==='general.architecture'||key==='general.name'||key==='general.file_type')result[key]=value;}
  else if(type===9){const itemType=u32(),n=u64();for(let j=0;j<n;j++){if(itemType===8)str();else if(sizes[itemType])read(sizes[itemType]);else throw Error(`Unsupported array type ${itemType}`)}}
  else if(sizes[type]){const b=read(sizes[type]);if(key==='general.file_type')result[key]=b.readUInt32LE(0)}
  else throw Error(`Unsupported metadata type ${type} at ${key}`);
}
console.log(JSON.stringify(result,null,2));fs.closeSync(fd);
function readAt(p,o,n){const b=Buffer.alloc(n);const h=fs.openSync(p,'r');fs.readSync(h,b,0,n,o);fs.closeSync(h);return b}
