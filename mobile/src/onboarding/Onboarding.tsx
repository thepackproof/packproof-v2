import { createContext,useContext,useEffect,useRef,useState,type ReactNode } from 'react';
import { AccessibilityInfo,Animated,AppState,Modal,Pressable,ScrollView,Text,View,useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OnboardingController,STEPS } from '../../../packages/onboarding/model';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
const Context=createContext<{controller:OnboardingController;targets:Map<string,View>;replay:()=>void}|null>(null);
export function OnboardingRoot({children}:{children:ReactNode}){
 const app=usePackProof();
 if(!app.hydrated||!app.session||app.route.name==='auth')return <>{children}</>;
 return <Provider key={`${app.apiBaseUrl}:${app.session.userId}`}>{children}</Provider>;
}
function Provider({children}:{children:ReactNode}){
 const app=usePackProof();const [controller]=useState(()=>new OnboardingController(app.client,{read:()=>AsyncStorage.getItem(`onboarding:${app.apiBaseUrl}:${app.session!.userId}`),write:value=>AsyncStorage.setItem(`onboarding:${app.apiBaseUrl}:${app.session!.userId}`,value)}));
 const [targets]=useState(()=>new Map<string,View>());const [,render]=useState(0);
 useEffect(()=>{const off=controller.subscribe(()=>render(n=>n+1));void controller.load();const sub=AppState.addEventListener('change',s=>{if(s==='active')void controller.refresh();});const timer=setInterval(()=>{if(AppState.currentState==='active')void controller.refresh();},15000);return()=>{off();sub.remove();clearInterval(timer);controller.stop();};},[controller]);
 const snapshot=controller.snapshot;
 useEffect(()=>{if(app.route.name==='home'&&!app.busy&&!snapshot.open)controller.start();},[app.route.name,app.busy,snapshot.state?.onboarding_completed,snapshot.open]);
 const replay=()=>{app.go('home');controller.start(true);};
 return <Context.Provider value={{controller,targets,replay}}>{children}{snapshot.open&&app.route.name==='home'&&<Overlay/>}{!snapshot.open&&snapshot.state?.first_proof_completed&&!snapshot.state.first_proof_coaching_completed&&app.route.name==='home'&&<View style={{position:'absolute',bottom:90,left:16,right:16}}><Coaching kind="complete"/></View>}</Context.Provider>;
}
export function TutorialTarget({name,children,flex}:{name:string;children:ReactNode;flex?:number}){const context=useContext(Context);return <View collapsable={false} style={flex?{flex}:undefined} ref={node=>{for(const key of name.split(' ').filter(Boolean)){if(node)context?.targets.set(key,node);else context?.targets.delete(key);}}}>{children}</View>;}
export function ReplayTutorial(){const context=useContext(Context);const {colors}=useTheme();return <Pressable accessibilityRole="button" onPress={()=>context?.replay()} style={{padding:14,borderWidth:1,borderColor:colors.primary,borderRadius:10}}><Text style={{color:colors.primary,fontSize:16}}>Replay Tutorial</Text></Pressable>;}
export function Coaching({kind}:{kind:'camera'|'secured'|'complete'}){
 const context=useContext(Context);const app=usePackProof();const {colors}=useTheme();const [hidden,setHidden]=useState(false);const state=context?.controller.snapshot.state;
 if(hidden||!state?.onboarding_enrolled||state.first_proof_coaching_completed||context?.controller.snapshot.open)return null;
 if(kind==='complete'&&!state.first_proof_completed)return null;
 return <View accessibilityLiveRegion="polite" style={{padding:12,marginVertical:8,borderWidth:1,borderColor:colors.primary,borderRadius:10,backgroundColor:colors.surface}}><Text style={{fontSize:16,lineHeight:22,color:colors.textPrimary}}>{kind==='camera'?'Keep recording while you pack. One continuous capture preserves the sequence.':kind==='secured'?'Capture secured locally. Your upload continues automatically; you may leave this screen.':'Your first Proof is complete.'}</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:16}}><Pressable accessibilityRole="button" style={{minHeight:44,justifyContent:'center'}} onPress={()=>{setHidden(true);if(kind==='complete'){context?.controller.dismissCoaching();if(state.first_proof_id)void app.run(()=>app.openProof(state.first_proof_id!));}}}><Text style={{color:colors.primary,fontSize:16}}>{kind==='complete'?'View Proof':'Got it'}</Text></Pressable><Pressable accessibilityRole="button" style={{minHeight:44,justifyContent:'center'}} onPress={()=>context?.controller.dismissCoaching()}><Text style={{color:colors.textSecondary,fontSize:16}}>Dismiss guidance</Text></Pressable></View></View>;
}
function Overlay(){
 const {controller,targets}=useContext(Context)!;const app=usePackProof();const {colors,reducedMotion}=useTheme();const {width,height}=useWindowDimensions();const insets=useSafeAreaInsets();const {step,replay}=controller.snapshot;const [rect,setRect]=useState({x:0,y:0,w:0,h:0});const [cardHeight,setCardHeight]=useState(240);const position=useRef({x:new Animated.Value(0),y:new Animated.Value(0),w:new Animated.Value(0),h:new Animated.Value(0)}).current;const fade=useRef(new Animated.Value(0)).current;
 useEffect(()=>{let active=true,viewed=false;AccessibilityInfo.announceForAccessibility(`${STEPS[step].title}. ${STEPS[step].body}. Step ${step+1} of ${STEPS.length}.`);const measure=()=>targets.get(STEPS[step].target)?.measureInWindow((x,y,w,h)=>{if(!active||!w||!h)return;setRect({x:Math.max(4,x-4),y:Math.max(insets.top,y-4),w:Math.min(w+8,width-8),h:h+8});if(!viewed){viewed=true;controller.viewed();}});measure();const timer=setInterval(measure,300);fade.setValue(0);Animated.timing(fade,{toValue:1,duration:reducedMotion?80:240,useNativeDriver:true}).start();return()=>{active=false;clearInterval(timer);};},[step,width,height,insets.top,controller,targets]);
 useEffect(()=>{Animated.parallel(Object.entries(position).map(([key,value])=>Animated.timing(value,{toValue:rect[key as keyof typeof rect],duration:reducedMotion?0:240,useNativeDriver:false}))).start();},[rect.x,rect.y,rect.w,rect.h,reducedMotion]);
 const above=rect.y+rect.h+cardHeight+24>height-insets.bottom;const top=Math.max(insets.top+12,Math.min(above?rect.y-cardHeight-16:rect.y+rect.h+16,height-insets.bottom-cardHeight-12));
 const button=(label:string,action:()=>void,disabled=false,primary=false)=><Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={action} style={{minHeight:44,paddingHorizontal:12,justifyContent:'center',borderRadius:8,backgroundColor:primary?colors.primary:'transparent',opacity:disabled?.4:1}}><Text style={{fontSize:16,color:primary?'#fff':colors.textPrimary}}>{label}</Text></Pressable>;
 return <Modal transparent visible statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={()=>controller.finish(true)}><View style={{flex:1}} accessibilityViewIsModal>
  <Animated.View pointerEvents="none" style={{position:'absolute',top:0,left:0,right:0,height:position.y,backgroundColor:'rgba(8,18,34,.36)'}}/>
  <Animated.View pointerEvents="none" style={{position:'absolute',top:Animated.add(position.y,position.h),left:0,right:0,bottom:0,backgroundColor:'rgba(8,18,34,.36)'}}/>
  <Animated.View pointerEvents="none" style={{position:'absolute',top:position.y,left:0,width:position.x,height:position.h,backgroundColor:'rgba(8,18,34,.36)'}}/>
  <Animated.View pointerEvents="none" style={{position:'absolute',top:position.y,left:Animated.add(position.x,position.w),right:0,height:position.h,backgroundColor:'rgba(8,18,34,.36)'}}/>
  <Animated.View pointerEvents="none" style={{position:'absolute',top:position.y,left:position.x,width:position.w,height:position.h,borderRadius:10,borderWidth:2,borderColor:colors.primary}}/>

  <Animated.View onLayout={e=>setCardHeight(e.nativeEvent.layout.height)} style={{position:'absolute',top,left:12,right:12,maxHeight:height-insets.top-insets.bottom-24,padding:18,borderRadius:14,backgroundColor:colors.surface,opacity:fade,transform:[{translateY:fade.interpolate({inputRange:[0,1],outputRange:reducedMotion?[0,0]:[6,0]})}]}}><ScrollView><Text style={{color:colors.textSecondary,fontSize:14}}>{replay?'Tutorial':'Getting started'} · {step+1} of {STEPS.length}</Text><Text accessibilityRole="header" style={{color:colors.textPrimary,fontSize:21,fontWeight:'600',marginVertical:10}}>{STEPS[step].title}</Text><Text style={{color:colors.textPrimary,fontSize:16,lineHeight:24,marginBottom:14}}>{STEPS[step].body}</Text><View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between'}}>{button('Skip',()=>controller.finish(true))}{button('Back',()=>controller.move(-1),step===0)}{button(step===5?'Create Proof':'Next',()=>{if(step===5){controller.finish();app.go('create');}else controller.move(1);},!rect.w,true)}</View></ScrollView><View pointerEvents="none" style={{position:'absolute',left:Math.min(width-50,Math.max(25,rect.x+rect.w/2-12)),[above?'bottom':'top']:-5,width:10,height:10,backgroundColor:colors.surface,transform:[{rotate:'45deg'}]}}/></Animated.View>
 </View></Modal>;
}
