import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppState} from 'react-native';
import {newStudyOperationNonce} from '../../modules/packproof-unified-camera';
import {createNativeStudyRuntime} from './native-study-core';
export type {NativeStudyStatus,NativeStudyTimer} from './native-study-core';
const runtime=createNativeStudyRuntime({storage:AsyncStorage,appState:AppState,newNonce:newStudyOperationNonce});
export const {registerStudyAccountReader,rememberNativeStudyConsent,updateNativeStudyConnectivity,startNativeStudy,nativeStudyForCapture,flushNativeStudyTimings}=runtime;
