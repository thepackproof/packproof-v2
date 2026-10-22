import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobileHomeScreen } from '../mobile-task/MobileHomeScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { CreateProofScreen } from '../screens/CreateProofScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { SampleProof } from '../site/SampleProof';
import { Onboarding } from '../onboarding/Onboarding';
import { draftStorageKey, creationOperation, completeCreation, readDraft } from '../first-experience/state';
import { App } from '../App';
import { saveSession } from '../auth/session';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/app'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const home = () => ({firstExperience:true, experience:{status:'FIRST_PROOF'}, reconciled:true, proofs:[], recordings:[], queue:[], loading:false, recordingsLoaded:true, error:null, refreshedAt:'2026-10-11T12:00:00Z',busy:false,notice:null,interactions:{},onGo:vi.fn(),onRetry:vi.fn(),onAction:vi.fn(),onOpen:vi.fn()});

it('shows the SIGNAL packing entry without labeling an unknown account new', () => {
  const props = home();
  const view = render(<MobileHomeScreen {...props} reconciled={false} experience={{status:'UNKNOWN'}} />);
  expect(screen.queryByRole('heading', {name:'Create your first Proof'})).not.toBeInTheDocument();
  view.rerender(<MobileHomeScreen {...props} />);
  expect(screen.getByRole('heading', {name:'Pack it. Keep the proof.'})).toBeInTheDocument();
  expect(screen.queryByRole('region', {name:'Workspace summary'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Pack an item'}));
  expect(props.onGo).toHaveBeenCalledWith('/new');
});

it('does not call an old activated account new after a cleared local cache', () => {
  render(<MobileHomeScreen {...home()} experience={{status:'ACTIVE'}} />);
  expect(screen.queryByRole('heading', {name:'Create your first Proof'})).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Pack an item'})).toBeInTheDocument();
});

it('keeps the established desktop composition except for confirmed empty accounts', () => {
  const props = {...home(),firstProof:true,connections:[],pendingUploadCount:0,onOpenProof:vi.fn(),onOpenInvitation:vi.fn(),onOpenReceiver:vi.fn()};
  const view = render(<HomeScreen {...props} />);
  expect(screen.getByRole('heading', {name:'Create your first Proof'})).toBeInTheDocument();
  expect(screen.queryByRole('region', {name:'Workspace summary'})).not.toBeInTheDocument();
  view.rerender(<HomeScreen {...props} firstExperience={false} />);
  expect(screen.getByRole('heading', {name:'Ready at the packing table.'})).toBeInTheDocument();
  expect(screen.getByRole('region', {name:'Workspace summary'})).toBeInTheDocument();
});

function creationProps(draftKey:string) {
  return {draftKey,busy:false,error:null,development:false,ebayConnected:false,onCancel:vi.fn(),onScan:vi.fn(),onOpenAccount:vi.fn(),onAcceptInvitation:vi.fn(),onCreate:vi.fn(),onCreateGrading:vi.fn(),onImportPurchase:vi.fn(),onListEbayOrders:vi.fn(),onImportEbayOrder:vi.fn(),onConfirmImport:vi.fn()};
}

it('restores manual fields after leaving or reopening only for the original account', () => {
  const key = draftStorageKey('/api','alice');
  const first = render(<CreateProofScreen {...creationProps(key)} />);
  fireEvent.change(screen.getByRole('textbox',{name:'Item name'}),{target:{value:'My ceramic mug'}});
  first.unmount();
  const second = render(<CreateProofScreen {...creationProps(key)} />);
  expect(screen.getByRole('textbox',{name:'Item name'})).toHaveValue('My ceramic mug');
  second.unmount();
  render(<CreateProofScreen {...creationProps(draftStorageKey('/api','bob'))} />);
  expect(screen.getByRole('textbox',{name:'Item name'})).toHaveValue('');
});

it('retains a stable create identity across response loss without using description as identity', () => {
  const key = draftStorageKey('/api','alice');
  const id = creationOperation(key);
  expect(creationOperation(key)).toBe(id);
  expect(creationOperation(draftStorageKey('/api','bob'))).not.toBe(id);
  completeCreation(key);
  expect(creationOperation(key)).not.toBe(id);
  expect(readDraft(key)).toBeNull();
});

it('supports password managers and deliberate visibility without requiring duplicate signup entry', () => {
  render(<SignInScreen firstExperience initialView="create-account" onSignedIn={vi.fn()} onGo={vi.fn()} />);
  const password = screen.getByLabelText('Password');
  expect(password).toHaveAttribute('autocomplete','new-password');
  expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Email'),{target:{value:'test@example.test'}});
  fireEvent.change(password,{target:{value:'secret-only-in-memory'}});
  fireEvent.click(screen.getByRole('button',{name:'Show password'}));
  expect(password).toHaveAttribute('type','text');
  expect(sessionStorage.getItem('packproof:first-proof:auth:v1')).not.toContain('secret-only-in-memory');
});

it('reuses a fictional viewer without real sharing, account requests or mutation tools', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
  history.replaceState({},'', '/sample-proof?view=case');
  render(<SampleProof readOnly />);
  expect(screen.getByText('Fictional Proof · sample only')).toBeInTheDocument();
  expect(screen.queryByText('More')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/Download sample/})).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not open or record the old tour on first-use entry', async () => {
  const state={onboarding_completed:false,onboarding_version:0,first_proof_coaching_completed:false,onboarding_last_step:null,onboarding_enrolled:true,current_version:1,first_proof_id:null,first_proof_completed:false};
  const api={getOnboarding:vi.fn(async()=>state),updateOnboarding:vi.fn(async()=>state)};
  render(<Onboarding api={api} accountKey="test" firstExperience dashboard ready onDashboard={vi.fn()} onCreate={vi.fn()} onViewProof={vi.fn()} />);
  await waitFor(()=>expect(api.getOnboarding).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.updateOnboarding).not.toHaveBeenCalled();
});

it('lets an authenticated account with no optional profile open its original manual task', async () => {
  vi.stubEnv('VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE','true');
  saveSession({apiBaseUrl:'',authMode:'dev',userId:'user_new',username:null,displayName:null,token:'fixture',refreshToken:null,accessExpiresAt:null,subject:'fixture'});
  history.replaceState({},'', '/new');
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({proofs:[],invitations:[],items:[],marketplaces:[],connections:[],sources:[]} ),{headers:{'content-type':'application/json'}})));
  render(<App />);
  expect(await screen.findByRole('textbox',{name:'Item name'})).toBeInTheDocument();
  expect(screen.queryByText('Complete your profile')).not.toBeInTheDocument();
});
