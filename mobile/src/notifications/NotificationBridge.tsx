import { useEffect } from 'react';
import { Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import { usePackProof } from '../app/PackProofProvider';
import { registerProofPush, setNotificationAccount } from './client';
import { notificationProofId } from './destination';
const presented=new Set<string>();
export function NotificationBridge(){
  const app=usePackProof();
  useEffect(()=>{
    if(!app.session?.userId)return;
    const userId=app.session.userId;
    let current=true;
    const clearAccount=setNotificationAccount(app.client,userId);
    Notifications.setNotificationHandler({handleNotification:async notification=>{
      const data=notification.request.content.data,id=String(data.notificationId??notification.request.identifier);
      const show=data.userId===userId&&!presented.has(id);
      if(show){presented.add(id);if(presented.size>200)presented.delete(presented.values().next().value!);}
      return {shouldShowAlert:show,shouldShowBanner:show,shouldShowList:show,shouldPlaySound:show,shouldSetBadge:false};
    }});
    void registerProofPush(app.client).catch(()=>undefined);
    const open=(response:Notifications.NotificationResponse|null)=>{
      const data=response?.notification.request.content.data;
      const proofId=notificationProofId(data,userId);
      if(!current || !data || !proofId)return;
      if(typeof data.notificationId==='string')void app.client.notificationRequest(`notifications/${encodeURIComponent(data.notificationId)}/read`,'POST',{}).catch(()=>undefined);
      app.saveProofRecordView(proofId,{...app.readProofRecordView(proofId),tab:'Timeline',timelineFilter:'MILESTONES'});
      void Linking.openURL(`packproof://proof/${proofId}`).catch(()=>undefined);
    };
    void Notifications.getLastNotificationResponseAsync().then(response=>{if(!current)return;open(response);void Notifications.clearLastNotificationResponseAsync();}).catch(()=>undefined);
    const listener=Notifications.addNotificationResponseReceivedListener(open);
    return()=>{current=false;listener.remove();clearAccount();Notifications.setNotificationHandler(null);};
  },[app.session?.userId,app.client]);
  return null;
}
