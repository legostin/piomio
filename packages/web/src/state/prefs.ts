// View preferences of this browser (not hub settings), kept in localStorage.

import { createStore } from "../lib/store";

const DETAILS = "ob.chat.details";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Detailed mode: the chat also shows tool calls and results, notes for the model and which brain answered. */
export const showDetails = createStore<boolean>(read(DETAILS));

export function setShowDetails(on: boolean): void {
  showDetails.set(on);
  try {
    localStorage.setItem(DETAILS, on ? "1" : "0");
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

const TAB = "ob.sidebar.tab";

export type SidebarTab = "agents" | "groups" | "channels";

function readTab(): SidebarTab {
  try {
    const v = localStorage.getItem(TAB);
    return v === "groups" || v === "channels" ? v : "agents";
  } catch {
    return "agents";
  }
}

/** The sidebar's tab: agents, group chats or channels. */
export const sidebarTab = createStore<SidebarTab>(readTab());

export function setSidebarTab(tab: SidebarTab): void {
  sidebarTab.set(tab);
  try {
    localStorage.setItem(TAB, tab);
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

const MACHINES = "ob.sidebar.machines";

/** The sidebar's machines block is open (its rows and who works there); closed, one line of dots. */
export const machinesOpen = createStore<boolean>(read(MACHINES));

export function setMachinesOpen(on: boolean): void {
  machinesOpen.set(on);
  try {
    localStorage.setItem(MACHINES, on ? "1" : "0");
  } catch {
    /* private mode: the choice lasts until reload */
  }
}
