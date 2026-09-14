import { useEffect,useState } from 'react';
import { Linking,Platform,Switch,Text,View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { categories,registerProofPush,syncLocalNotificationSettings,refreshLocalNotificationSettings,type NotificationPreferences,type ProofNotification } from './client';
export function NotificationCenter(){
  const app=usePackProof(),{colors}=useTheme();
  const [prefs,setPrefs]=useState<NotificationPreferences|null>(null),[updates,setUpdates]=useState<ProofNotification[]>([]),[error,setError]=useState<string|null>(null),[status,setStatus]=useState('Checking device notification permission…'),[busy,setBusy]=useState(false);
  async function load(){try{await app.ensureAuth();const [p,n]=await Promise.all([app.client.notificationRequest<NotificationPreferences>('notification-preferences'),app.client.notificationRequest<{notifications:ProofNotification[]}>('notifications')]);setPrefs(p);setUpdates(n.notifications);setError(null);setStatus(await registerProofPush(app.client));}catch{setError('Notification settings could not load. Reconnect and retry.');}}
  useEffect(()=>{void load();},[app.session?.userId]);
  async function change(key:keyof NotificationPreferences,value:boolean){setBusy(true);try{const next=await app.client.notificationRequest<NotificationPreferences>('notification-preferences','PATCH',{[key]:value});setPrefs(next);await syncLocalNotificationSettings(next);setError(null);}catch{setError('This setting was not saved. Try again.');}finally{setBusy(false);}}
  return <View style={{gap:16}}>
    <Text style={[typography.secondary,{color:colors.textSecondary}]}>{status}</Text>
    <View style={{gap:6}}><Button label="Enable or reconnect device notifications" variant="secondary" onPress={()=>{void registerProofPush(app.client,true).then(setStatus).catch(()=>setError('Reconnect and try again.'));}}/><Button label="Device notification settings" variant="tertiary" onPress={()=>void Linking.openSettings()}/></View>
    {prefs?([['enabled','Proof notifications'],...categories] as const).map(([key,label])=><View key={key} style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12,minHeight:48}}><Text style={[typography.body,{color:colors.textPrimary,flex:1}]}>{label}</Text><Switch accessibilityLabel={label} value={prefs[key]} disabled={busy||(key!=='enabled'&&!prefs.enabled)} onValueChange={value=>void change(key,value)}/></View>):null}
    <Text style={[typography.finePrint,{color:colors.textSecondary}]}>Muted updates stay in your history.{Platform.OS==='android' ? ' Android may still show the upload service while a transfer runs.' : ''}</Text>
    {error?<Text accessibilityRole="alert" style={[typography.secondary,{color:colors.error}]}>{error}</Text>:null}
    <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><Text style={[typography.sectionTitle,{color:colors.textPrimary}]}>Notification history</Text><Button label="Refresh" variant="tertiary" onPress={()=>void load()}/></View>
    {!updates.length?<Text style={[typography.body,{color:colors.textSecondary}]}>Meaningful Proof updates will appear here.</Text>:updates.map(update=><View key={update.id} style={{borderLeftWidth:2,borderColor:colors.accent,paddingLeft:12,gap:4}}><Button label={update.title} variant="tertiary" onPress={()=>{void app.client.notificationRequest(`notifications/${encodeURIComponent(update.id)}/read`,'POST',{}).catch(()=>undefined);app.saveProofRecordView(update.proofId,{...app.readProofRecordView(update.proofId),tab:'Timeline',timelineFilter:'MILESTONES'});void app.run(()=>app.openProof(update.proofId));}}/><Text style={[typography.finePrint,{color:colors.textSecondary}]}>{new Date(update.createdAt).toLocaleString()}</Text></View>)}
  </View>;
}
export function ProofNotificationMute(){
  const app=usePackProof(),{colors}=useTheme(),id=app.proof?.proofId;
  const [muted,setMuted]=useState(false),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  useEffect(()=>{let current=true;if(id)void app.client.proofNotificationMute<{muted:boolean}>(id!).then(r=>{if(current){setMuted(r.muted);setLoaded(true);}}).catch(()=>{if(current)setError(true);});return()=>{current=false;};},[id]);
  return <View style={{gap:6}}><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><Text style={[typography.body,{color:colors.textPrimary}]}>Mute this Proof</Text><Switch accessibilityLabel="Mute this Proof" value={muted} disabled={!loaded||busy} onValueChange={value=>{setBusy(true);void app.client.proofNotificationMute<{muted:boolean}>(id!,'POST',{muted:value}).then(async r=>{setMuted(r.muted);setError(false);await refreshLocalNotificationSettings(app.client);}).catch(()=>setError(true)).finally(()=>setBusy(false));}}/></View>{error?<Text style={[typography.secondary,{color:colors.error}]}>Notification preference could not load or save. Reopen the Proof to retry.</Text>:null}</View>;
}
