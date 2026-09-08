import { UsagePanel } from "../components/UsagePanel";
import { BillingPanel } from "../components/BillingPanel";
import { StudyConsentPanel } from "../components/StudyConsentPanel";
import { useState, type ReactNode } from "react";
import { displayName } from "@packproof/copy/format";
import type { AppearancePreference } from "@packproof/theme/tokens";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";
import type { PackProofApi } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { IconChevron } from "../components/Icons";
import { useTheme } from "../theme/ThemeProvider";
import { PlanBillingPanel } from "../components/PlanBillingPanel";
import { AccountDeletionRequestPanel } from "./AccountDeletionScreen";
import { RecordingsSettingsPanel } from "./RecordingsSettingsPanel";
import "./account-settings.css";

const APPEARANCE_OPTIONS: Array<{ id: AppearancePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Match this device" },
  { id: "light", label: "Light", hint: "Always use light PackProof" },
  { id: "dark", label: "Dark", hint: "Always use dark PackProof" },
];

function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="settings-detail" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>{open && <div className="stack">{children}</div>}
  </details>;
}

export function AccountScreen(props: {
  api?: PackProofApi;
  userId?: string;
  onOpenProof?: (proofId: string) => void;
  displayName: string | null;
  username: string | null;
  subject: string;
  connections: CommerceConnectionView[];
  connectedAccounts: ConnectedAccountView[];
  connectedProviders: ConnectedAccountProviderCatalogView[];
  connectedNotice: string | null;
  error: string | null;
  busy: boolean;
  displayNameInput: string;
  usernameInput: string;
  onDisplayNameChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onSaveProfile: () => void;
  onOpenDeveloper?: () => void;
  onOpenStation: () => void;
  onOpenStores: () => void;
  onOpenFulfillment: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
  onConnectAccount: (provider: string, extra?: { shop?: string }) => void;
  onReauthorizeAccount: (accountId: string) => void;
  onDisconnectAccount: (accountId: string) => void;
  onBack: () => void;
  onSignOut: () => void;
}) {
  const theme = useTheme();
  const name = displayName({ displayName: props.displayName, username: props.username, fallback: "Your account" });
  const profileChanged = props.displayNameInput.trim() !== (props.displayName ?? "").trim()
    || (!props.username && props.usernameInput.trim().length > 0);
  const channelCount = new Set([...props.connectedAccounts.map(account => account.provider), ...props.connections.map(connection => connection.provider)]).size;
  return <main className="page stack account-settings">
    <PageHeader title="Account" onBack={props.onBack} />
    {props.error && <div className="banner banner-error" role="alert">{props.error}</div>}
    <section><h2 className="card-title">{name}</h2>{props.username && <p className="meta">@{props.username}</p>}</section>
    <div className="settings-list">
      <SettingsDisclosure title="Profile">
        {!props.username && <label className="field"><span>Username</span><input value={props.usernameInput} onChange={event => props.onUsernameChange(event.target.value)} autoComplete="username" /></label>}
        <label className="field"><span>Display name</span><input value={props.displayNameInput} onChange={event => props.onDisplayNameChange(event.target.value)} autoComplete="name" /></label>
        {profileChanged && <button className="btn" type="button" disabled={props.busy} onClick={props.onSaveProfile}>Save profile</button>}
        {props.api && <SettingsDisclosure title="Plan and billing"><PlanBillingPanel api={props.api} />{props.userId && <><UsagePanel api={props.api} userId={props.userId} /><BillingPanel api={props.api} userId={props.userId} /></>}</SettingsDisclosure>}
      </SettingsDisclosure>
      <button className="settings-row" type="button" onClick={props.onOpenStores}><span><strong>Sales channels</strong><span className="meta" style={{display:"block"}}>{channelCount ? `${channelCount} ${channelCount === 1 ? "channel" : "channels"} connected or needing attention` : "Connect a selling account"}</span></span><IconChevron /></button>
      <SettingsDisclosure title="Recordings on this device">
        {props.api && props.userId && props.onOpenProof ? <RecordingsSettingsPanel api={props.api} userId={props.userId} onOpenProof={props.onOpenProof} /> : <p className="note">Open Orders to find recordings that need attention. Keep this browser's data until your recordings have finished saving.</p>}
      </SettingsDisclosure>
      <SettingsDisclosure title="Appearance">
        <fieldset className="appearance-list" style={{border:0,padding:0,margin:0}}><legend className="meta">Choose how PackProof looks</legend>{APPEARANCE_OPTIONS.map(option => <label key={option.id} className={`appearance-row${theme.preference === option.id ? " appearance-row-selected" : ""}`}>
          <span><strong>{option.label}</strong><span className="meta" style={{display:"block"}}>{option.hint}</span></span>
          <input type="radio" name="packproof-appearance" value={option.id} checked={theme.preference === option.id} onChange={() => theme.setPreference(option.id)} />
        </label>)}</fieldset>
      </SettingsDisclosure>
      <SettingsDisclosure title="Help & support">
        <p className="note">Choose an order, record the item being packed and sealed, then review the recording and confirm what you are shipping. PackProof shows when saving is complete.</p>
        <p className="note">If saving is interrupted, return to that Proof to continue. Keep your local recording until PackProof confirms it is preserved.</p>
        <p className="note">For account or privacy support, use the contact information in the Privacy Policy.</p>
        <button className="btn btn-tertiary" type="button" onClick={props.onOpenPrivacy}>Support contact information</button>
        {props.onOpenDeveloper && <SettingsDisclosure title="Developer tools"><button className="btn btn-secondary" type="button" onClick={props.onOpenDeveloper}>Developer access</button></SettingsDisclosure>}
      </SettingsDisclosure>
      <SettingsDisclosure title="Privacy & account">
        {props.api && props.userId && <SettingsDisclosure title="Optional research participation"><StudyConsentPanel api={props.api} userId={props.userId} /></SettingsDisclosure>}
        <p className="note">PackProof records what was submitted, when, and by whom. It does not decide who is right.</p>
        <button className="btn btn-tertiary" type="button" onClick={props.onOpenPrivacy}>Privacy Policy</button>
        <button className="btn btn-tertiary" type="button" onClick={props.onOpenTerms}>Terms of Service</button>
        <SettingsDisclosure title="Delete account">{props.api ? <AccountDeletionRequestPanel api={props.api} accountKey={props.userId ?? props.subject} /> : <p className="note">Sign in to request deletion of your account.</p>}<a href="/new/delete-account">Open account deletion page</a></SettingsDisclosure>
      </SettingsDisclosure>
    </div>
    <button className="btn btn-tertiary" type="button" disabled={props.busy} onClick={props.onSignOut}>Sign out</button>
  </main>;
}
