import { expect, it, vi } from 'vitest';
import { distinctLocations, WorkspaceFolderOffers, type FolderOption } from '../main/workspace-folder-offers';
import { argumentsByMethod } from '../main/security';
import type { WorkspaceFolderSuggestion } from '../ui/workspace-types';

const sales: FolderOption = {folder: 'C:\\Exports\\Sales', kind: 'discovered', label: 'Sales order lines', sampleFile: 'sales.csv'};
const packing: WorkspaceFolderSuggestion = {folder: 'C:\\Exports\\Packing', kind: 'discovered', label: 'Packing records'};

it('keeps the recognized source when it is also a prepared or selected location', () => {
  expect(distinctLocations([sales, packing, {folder: 'c:/exports/SALES', kind: 'prepared'}])).toEqual([sales, packing]);
});

it('accepts a non-first result only for the role and schema that were offered', async () => {
  const offers = new WorkspaceFolderOffers();
  const same = vi.fn(async () => [sales, packing]);
  const shown = offers.remember('order', [sales, packing]);
  expect(shown[0]).not.toHaveProperty('sampleFile');
  await expect(offers.confirm('order', sales.folder, same)).resolves.toEqual(sales);
  await expect(offers.confirm('order', packing.folder, same)).resolves.toEqual(packing);
  expect(same).toHaveBeenCalledWith(true);
  same.mockClear();
  await expect(offers.confirm('shipping', packing.folder, same)).rejects.toThrow();
  await expect(offers.confirm('order', 'C:\\Unrelated', same)).rejects.toThrow();
  expect(same).not.toHaveBeenCalled();
  await expect(offers.confirm('order', sales.folder, async () => [])).rejects.toThrow();
  await expect(offers.confirm('order', sales.folder, async () => [{...sales, label: 'Different export'}])).rejects.toThrow();
});

it('keeps checking a fallback separate from scanning the computer', async () => {
  const offers = new WorkspaceFolderOffers();
  const fallback: WorkspaceFolderSuggestion = {folder: sales.folder, kind: 'prepared'};
  const refresh = vi.fn(async () => [fallback]);
  offers.remember('order', [fallback]);
  await expect(offers.confirm('order', sales.folder, refresh)).resolves.toEqual(fallback);
  expect(refresh).toHaveBeenCalledWith(false);
});

it('takes only a workflow role from the renderer when scanning', () => {
  expect(argumentsByMethod.discoverWorkspaceFolders.safeParse(['packing']).success).toBe(true);
  expect(argumentsByMethod.discoverWorkspaceFolders.safeParse(['packing', 'C:\\']).success).toBe(false);
  expect(argumentsByMethod.discoverWorkspaceFolders.safeParse(['directory']).success).toBe(false);
});
