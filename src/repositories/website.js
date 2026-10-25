import {escapeRegex as escape} from '../utils/search.js';
import {Settings,Gallery,Review,Visitor} from '../models/Website.js';
import {Enquiry} from '../models/Enquiry.js';
import {defaultSettings} from '../config/defaultSettings.js';
function filterFor(query,kind){const filter={};if(query.status)filter.status=query.status;if(query.q){const re=new RegExp(escape(query.q),'i');filter.$or=(kind==='reviews'?['name','text']:kind==='visitors'?['visitorKey','paths','device']:['name','phone','email','message','serviceName']).map(field=>({[field]:re}));}if(query.from||query.to){const f=kind==='visitors'?'lastSeen':'createdAt';filter[f]={};if(query.from)filter[f].$gte=new Date(query.from+'T00:00:00.000Z');if(query.to)filter[f].$lte=new Date(query.to+'T23:59:59.999Z');}return filter;}
async function list(model,query,kind){const filter=filterFor(query,kind),page=query.page||1,limit=query.limit||20;const [items,total]=await Promise.all([model.find(filter).select('-imageData').sort(kind==='visitors'?{lastSeen:-1}:{createdAt:-1,_id:-1}).skip((page-1)*limit).limit(limit).lean(),model.countDocuments(filter)]);return {items,total,page,limit,pages:Math.ceil(total/limit)};}
export const websiteRepository={
 async getSettings(){const value=await Settings.findOne({key:'public'}).lean();return {...defaultSettings,...value?.data};},
 async updateSettings(data){const row=await Settings.findOneAndUpdate({key:'public'},{$set:{data}},{upsert:true,new:true,runValidators:true}).lean();return {...defaultSettings,...row.data};},
 listGallery:()=>Gallery.find().sort({sortOrder:1,createdAt:-1}).lean(),
 createGallery:async data=>{const last=await Gallery.findOne().sort({sortOrder:-1}).lean();return Gallery.create({...data,sortOrder:(last?.sortOrder??-1)+1});},
 deleteGallery:id=>Gallery.findByIdAndDelete(id).lean(),
 async orderGallery(ids){const total=await Gallery.countDocuments({_id:{$in:ids}});if(total!==ids.length||await Gallery.countDocuments()!==ids.length)return false;await Gallery.bulkWrite(ids.map((id,i)=>({updateOne:{filter:{_id:id},update:{$set:{sortOrder:i}}}})));return true;},
 createReview:data=>Review.create(data),
 listReviews:query=>list(Review,query,'reviews'),
 setReviewStatus:(id,status)=>Review.findByIdAndUpdate(id,{$set:{status}},{new:true,runValidators:true}).select('-imageData').lean(),
 getReviewImage:id=>Review.findById(id).select('+imageData').lean(),
 async trackVisit({visitorKey,path,device}){const now=new Date(),day=now.toISOString().slice(0,10);return Visitor.findOneAndUpdate({visitorKey,day},{$inc:{views:1},$addToSet:{paths:path},$set:{lastSeen:now,device,expiresAt:new Date(now.getTime()+30*86400000)},$setOnInsert:{firstSeen:now}},{upsert:true,new:true}).lean();},
 listVisitors:query=>list(Visitor,query,'visitors'),
 async dashboard(){const [enquiries,newEnquiries,pendingReviews,gallery,visitorSessions]=await Promise.all([Enquiry.countDocuments(),Enquiry.countDocuments({status:'new'}),Review.countDocuments({status:'pending'}),Gallery.countDocuments(),Visitor.countDocuments()]);return {enquiries,newEnquiries,pendingReviews,gallery,visitorSessions};},
};
