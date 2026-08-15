'use strict';
const PtpCamera = require('../camera-ptp.js');
const FAKE_JPEG = Buffer.from('FFD8FFE000104A46494600010100000100010000FFDB0043FFD9','hex');
function u16(v){return[v&255,(v>>>8)&255]}
function u32(v){v=v>>>0;return[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255]}
function pkt(type,code,tid,payloadBytes){const body=payloadBytes||[];const head=u32(12+body.length).concat(u16(type)).concat(u16(code)).concat(u32(tid));return Buffer.from(head.concat(body));}
function strBytes(s){const b=[s.length];for(let i=0;i<s.length;i++)b.push(s.charCodeAt(i)&255);return b}
class MockCamera{
  constructor(){this.sessionOpen=false;this.log=[];this.getEventCleared=false;this.pendingObjects={100:FAKE_JPEG}}
  handleWrite(buf){
    const len=buf.readUInt32LE(0),type=buf.readUInt16LE(4),code=buf.readUInt16LE(6),tid=buf.readUInt32LE(8);
    if(type!==1)throw new Error('expect command, got '+type);
    this.log.push('0x'+code.toString(16));
    return this._answer(code,tid);
  }
  _answer(code,tid){
    switch(code){
      case 0x1001:return[pkt(3,0x2001,tid)];
      case 0x1004:{const b=[];b.push(...u16(100),...u32(6),...u16(100),...strBytes('microsoft.com: 1.0;'),...u16(0),...u32(1),...u16(0x910F),...u32(1),...u16(0xC181),...u32(0),...u32(1),...u16(0x3801),...u32(1),...u16(0x3801),...strBytes('Canon Inc.'),...strBytes('Canon EOS 5D Mark II'),...strBytes('2.1.2'),...strBytes('serial-x'));return[pkt(2,0x1004,tid,b),pkt(3,0x2001,tid)]}
      case 0x9114:case 0x9115:case 0x911D:return[pkt(3,0x2001,tid)];
      case 0x910F:{const evt=pkt(4,0xC181,tid,u32(100));return[evt,pkt(3,0x2001,tid)]}
      case 0x9116:{const b=[];if(!this.getEventCleared){b.push(...u32(1),...u32(0xC181),...u32(100),...u32(0),...u32(0),...u32(0));this.getEventCleared=true}else b.push(...u32(0));return[pkt(2,0x9116,tid,b),pkt(3,0x2001,tid)]}
      case 0x9104:{return[pkt(2,0x9104,tid,FAKE_JPEG),pkt(3,0x2001,tid)]}
      default:return[pkt(3,0x2002,tid)]
    }
  }
}
class MockTransport{
  constructor(camera){this.camera=camera;this.outQueue=[]}
  bulkOut(data,timeoutMs){const replies=this.camera.handleWrite(Buffer.from(data.buffer,data.byteOffset,data.byteLength));for(const r of replies)this.outQueue.push(r);return Promise.resolve()}
  bulkIn(maxLen,timeoutMs){if(!this.outQueue.length)return Promise.resolve(new Uint8Array(0));const bytes=this.outQueue.shift();return Promise.resolve(new Uint8Array(bytes.buffer,bytes.byteOffset,Math.min(bytes.length,maxLen)))}
  release(){}
}
(async()=>{
  const cam=new MockCamera();
  const ptp=new PtpCamera(new MockTransport(cam));
  await ptp.openSession();
  const info=await ptp.getDeviceInfo();
  console.log('model:',info.model);
  await ptp.setRemoteMode();await ptp.setEventMode();
  await ptp.releaseShutter();
  const oid=await ptp.waitForObject(5000);
  console.log('oid:',oid,'cmd log:',cam.log.join(','));
  console.log('before getObject');
  const jpeg=await ptp.getObject(oid);
  console.log('after getObject len:',jpeg.length);
  process.exit(0);
})().catch(e=>{console.error('ERR',e&&e.stack||e);process.exit(1)});
