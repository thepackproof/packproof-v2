import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { PackProofV2Client } from '../v2-api';

export type NotificationPreferences={enabled:boolean;uploads:boolean;evidence:boolean;participants:boolean;shipments:boolean;returns:boolean};
export const categories=[['uploads','Uploads and recovery'],['evidence','Evidence and seals'],['participants','Participant activity'],['shipments','Shipment updates'],['returns','Receipt and returns']] as const;
export type ProofNotification={id:string;proofId:string;eventId:string;title:string;category:string;createdAt:string;readAt:string|null};
const native=requireOptionalNativeModule<{setNotificationOptions?:(enabled:boolean,uploads:boolean,muted:string[])=>Promise<void>}>('PackProofUnifiedCamera');
let registeredToken:string|null=null;
let mutedProofs:string[]=[];
export async function syncLocalNotificationSettings(prefs:NotificationPreferences,muted:string[]=mutedProofs){
  mutedProofs=muted;
  await native?.setNotificationOptions?.(prefs.enabled,prefs.uploads&&!registeredToken,muted);
}
export async function refreshLocalNotificationSettings(client:PackProofV2Client){
  const [prefs,result]=await Promise.all([client.notificationRequest<NotificationPreferences>('notification-preferences'),client.notificationRequest<{proofIds:string[]}>('notification-mutes')]);
  await syncLocalNotificationSettings(prefs,result.proofIds);
  return prefs;
}
export async function registerProofPush(client:PackProofV2Client,ask=false):Promise<string>{
  const prefs=await refreshLocalNotificationSettings(client);
  if(!prefs.enabled)return 'Proof notifications are switched off.';
  for(const [key,name] of categories)await Notifications.setNotificationChannelAsync(`packproof_${key}`,{name,importance:Notifications.AndroidImportance.DEFAULT});
  let permission=await Notifications.getPermissionsAsync();
  if(!permission.granted&&ask)permission=await Notifications.requestPermissionsAsync();
  if(!permission.granted)return 'Notifications are blocked in Android settings.';
  const projectId=Constants.expoConfig?.extra?.eas?.projectId??Constants.easConfig?.projectId;
  try{
    const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
    await client.notificationRequest('push-devices','POST',{token,active:true});registeredToken=token;
    await syncLocalNotificationSettings(prefs);
    return 'Push notifications are enabled on this device.';
  }catch{return 'Android permission is enabled. Remote push could not connect; retry below. Updates remain in your notification history.';}
}
export async function unregisterProofPush(client:PackProofV2Client){
  const token=registeredToken;registeredToken=null;mutedProofs=[];
  await native?.setNotificationOptions?.(false,false,[]);
  if(token)await client.notificationRequest('push-devices','POST',{token,active:false}).catch(()=>undefined);
}
