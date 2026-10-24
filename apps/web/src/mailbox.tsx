// The mailbox switcher: each connected Gmail account is a mailbox, and every page shows the
// one picked here. The pick is remembered in this browser; it falls back to the first account.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@columenlabs/lumen-ui/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@columenlabs/lumen-ui/ui/sidebar';
import type { ConnectedAccount } from '@mailcellar/schema';
import { CheckIcon, ChevronsUpDownIcon, MailIcon, PlusIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { useMe } from './auth';

const KEY = 'mailcellar.mailbox';
const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (id: string) => {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
};

interface Mailbox {
  /** The mailbox every page shows; null when no Gmail account is connected. */
  account: ConnectedAccount | null;
  accounts: ConnectedAccount[];
  pick: (id: string) => void;
}

const MailboxContext = createContext<Mailbox>({ account: null, accounts: [], pick: () => {} });
export const useMailbox = () => useContext(MailboxContext);

export function MailboxProvider({ children }: { children: ReactNode }) {
  const accounts = useMe().data?.accounts ?? [];
  const [picked, setPicked] = useState(read);
  const account = accounts.find((a) => a.id === picked) ?? accounts[0] ?? null;
  const pick = (id: string) => {
    setPicked(id);
    write(id);
  };
  return <MailboxContext.Provider value={{ account, accounts, pick }}>{children}</MailboxContext.Provider>;
}

/** The sidebar's top: the mailbox shown, and a menu to switch to another or add one. */
export function MailboxSwitcher() {
  const { isMobile } = useSidebar();
  const { account, accounts, pick } = useMailbox();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={account?.email ?? 'MailCellar'}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <MailIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{account?.email ?? 'No mailbox yet'}</span>
                <span className="truncate text-xs text-muted-foreground">MailCellar</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-64 rounded-lg" align="start" side={isMobile ? 'bottom' : 'right'} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Mailboxes</DropdownMenuLabel>
            {accounts.map((a) => (
              <DropdownMenuItem key={a.id} className="gap-2 p-2" onSelect={() => pick(a.id)}>
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <MailIcon className="size-3.5 shrink-0" />
                </div>
                <span className="flex-1 truncate">{a.email}</span>
                {!a.modify && <span className="text-xs text-muted-foreground">Read only</span>}
                {a.id === account?.id && <CheckIcon className="size-4" />}
              </DropdownMenuItem>
            ))}
            {accounts.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem asChild className="gap-2 p-2">
              <a href="/api/accounts/connect">
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <PlusIcon className="size-3.5 shrink-0" />
                </div>
                Add Gmail account
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
