// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FolderSuggestions } from "./FolderSuggestions";
import { bridgeFor, selected } from "../test-fixtures";
import type { WorkspaceFolderSuggestion } from "../workspace-types";
afterEach(cleanup);

it("shows honest animated discovery without fake percentages or consent claims",async()=>{
 let resolve!: (suggestions:WorkspaceFolderSuggestion[])=>void;
 const pending=new Promise<WorkspaceFolderSuggestion[]>(r=>{resolve=r;});
 const bridge=bridgeFor(selected,{discoverWorkspaceFolders:vi.fn(()=>pending),useWorkspaceFolderSuggestion:vi.fn(async()=>selected)});
 const onChoose=vi.fn();
 render(<FolderSuggestions role="order" busy={false} bridge={bridge} onChoose={onChoose}/>);
 expect(screen.getByRole("status")).toHaveTextContent("Looking in common export folders");
 expect(screen.getByText("Finding your systems.")).toBeVisible();
 expect(screen.queryByText(/12 seconds remaining|3 source signatures|100%/i)).toBeNull();
 await act(async()=>resolve([{kind:"discovered",folder:"C:\\\\Sample\\\\ERP",label:"Sales records",evidence:"Order number header recognized"}]));
 expect(await screen.findByRole("group",{name:"Matching exports"})).toBeVisible();
 expect(screen.getByText(/Order number header recognized/)).toBeVisible();
 fireEvent.click(screen.getByRole("button",{name:/Sales records/}));
 expect(onChoose).toHaveBeenCalledWith("C:\\\\Sample\\\\ERP");
});
