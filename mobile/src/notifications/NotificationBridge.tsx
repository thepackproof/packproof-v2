import { useEffect } from 'react';
import { Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import { usePackProof } from '../app/PackProofProvider';
import { registerProofPush } from './client';
const presented=new Set<string>();
export function NotificationBridge(){
  const app=usePackProof();
  useEffect(()=>{
    if(!app.session?.userId)return;
    const userId=app.session.userId;
    Notifications.setNotificationHandler({handleNotification:async notification=>{
      const data=notification.request.content.data,id=String(data.notificationId??notification.request.identifier);
      const show=data.userId===userId&&!presented.has(id);
      if(show){presented.add(id);if(presented.size>200)presented.delete(presented.values().next().value!);}
      return {shouldShowAlert:show,shouldPlaySound:show,shouldSetBadge:false};
    }});
    void registerProofPush(app.client).catch(()=>undefined);
    const open=(response:Notifications.NotificationResponse|null)=>{
      const data=response?.notification.request.content.data;
      if(data?.userId!==userId||typeof data.proofId!=='string'||!/^proof_[A-Za-z0-9_-]+$/.test(data.proofId))return;
      if(typeof data.notificationId==='string')void app.client.notificationRequest(`notifications/${encodeURIComponent(data.notificationId)}/read`,'POST',{}).catch(()=>undefined);
      app.saveProofRecordView(data.proofId,{...app.readProofRecordView(data.proofId),tab:'Timeline',timelineFilter:'MILESTONES'});
      void Linking.openURL(`packproof://proof/${data.proofId}`);
    };
    void Notifications.getLastNotificationResponseAsync().then(response=>{open(response);void Notifications.clearLastNotificationResponseAsync();}).catch(()=>undefined);
    const listener=Notifications.addNotificationResponseReceivedListener(open);
    return()=>listener.remove();
  },[app.session?.userId,app.client]);
  return null;
}
