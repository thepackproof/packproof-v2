import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState,Platform} from 'react-native';
import {newStudyOperationNonce} from '../../modules/packproof-unified-camera';
import {createNativeStudyRuntime} from './native-study-core';
export type {NativeStudyStatus,NativeStudyTimer} from './native-study-core';
const runtime=createNativeStudyRuntime({storage:AsyncStorage,appState:AppState,newNonce:newStudyOperationNonce,sourceBuildSha:()=>process.env.EXPO_PUBLIC_PACKPROOF_BUILD_SHA,defaultDeviceClass:Platform.OS==='ios'?'ios':'other_android'});
export const {registerStudyAccountReader,rememberNativeStudyConsent,updateNativeStudyConnectivity,startNativeStudy,nativeStudyForCapture,flushNativeStudyTimings,recordNativeStudyInteraction}=runtime;
