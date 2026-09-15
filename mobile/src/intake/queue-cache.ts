import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IntakeOrder } from './model';
export const intakeQueueCacheKey = (api: string, account: string) => `packproof.intake-queue:v1:${encodeURIComponent(api.replace(/\/+$/, ''))}:${encodeURIComponent(account)}`;
export interface IntakeQueueCache { savedAt: number; orders: IntakeOrder[] }
export async function loadIntakeQueueCache(api: string, account: string): Promise<IntakeQueueCache | null> {
  try { const value = JSON.parse(await AsyncStorage.getItem(intakeQueueCacheKey(api, account)) || 'null'); return value && Number.isFinite(value.savedAt) && Array.isArray(value.orders) ? value : null; } catch { return null; }
}
export async function saveIntakeQueueCache(api: string, account: string, orders: IntakeOrder[]): Promise<void> {
  await AsyncStorage.setItem(intakeQueueCacheKey(api, account), JSON.stringify({ savedAt: Date.now(), orders }));
}
export async function clearIntakeQueueCache(api: string, account: string): Promise<void> { await AsyncStorage.removeItem(intakeQueueCacheKey(api, account)); }
