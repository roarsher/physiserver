import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileTypeFromBuffer} from 'file-type';
import sharp from 'sharp';
export async function inspectMedia(file,{imageOnly=false}={}){
 if(!file)throw Object.assign(new Error('Choose a file'),{status:400});
 const type=await fileTypeFromBuffer(file.buffer);
 const images=['image/jpeg','image/png','image/webp','image/gif'];const videos=['video/mp4','video/webm'];
 if(!type||(!images.includes(type.mime)&&(!videos.includes(type.mime)||imageOnly)))throw Object.assign(new Error(imageOnly?'Use a JPEG, PNG or WebP image':'Use a JPEG, PNG, WebP, GIF, MP4 or WebM file'),{status:400});
 if(images.includes(type.mime)){
  if(file.size>5*1024*1024)throw Object.assign(new Error('Images must be under 5 MB'),{status:400});
  try{const buffer=await sharp(file.buffer,{limitInputPixels:40000000}).rotate().resize({width:imageOnly?1000:1800,height:imageOnly?1000:1800,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();return {buffer,mime:'image/webp',ext:'webp',kind:'image'};}catch{throw Object.assign(new Error('The image cannot be read'),{status:400});}
 }
 return {buffer:file.buffer,mime:type.mime,ext:type.ext,kind:'video'};
}
export async function saveMedia(media,directory){await mkdir(directory,{recursive:true});const fileName=randomUUID()+'.'+media.ext;await writeFile(path.join(directory,fileName),media.buffer);return fileName;}
export async function removeMedia(fileName,directory){if(!/^[\da-f-]+\.(webp|mp4|webm)$/.test(fileName))return;try{await unlink(path.join(directory,fileName));}catch(e){if(e.code!=='ENOENT')throw e;}}
