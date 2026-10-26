// Admin ▸ People: who may use MailCellar, their access, invites and the audit log. Lumen's People
// screens over the kit's routes at /api/people (members.ts). Only admins see it.
import { LumenInviteAccept, LumenPeople, type PeopleSection, peopleClient } from '@columenlabs/lumen-ui/people';
import { Button } from '@columenlabs/lumen-ui/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@columenlabs/lumen-ui/ui/empty';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LogOutIcon, UserXIcon } from 'lucide-react';

const people = peopleClient('/api/people');

export const PEOPLE_SECTIONS: { section: PeopleSection; title: string }[] = [
  { section: 'people', title: 'People' },
  { section: 'invites', title: 'Invites' },
  { section: 'permissions', title: 'Permissions' },
  { section: 'audit', title: 'Audit log' },
];

export function PeoplePage({ section }: { section: PeopleSection }) {
  const navigate = useNavigate();
  return (
    <LumenPeople
      adapter={people}
      crumbs={[{ label: 'Admin' }]}
      section={section}
      onSection={(s) => void navigate({ to: `/admin/${s}` })}
    />
  );
}

/** Where an invite email's link lands: accept, then into the app. */
export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <LumenInviteAccept
      adapter={people}
      token={token}
      onAccepted={async () => {
        await client.invalidateQueries({ queryKey: ['me'] });
        void navigate({ to: '/' });
      }}
      onSwitchAccount={() => window.location.assign('/cdn-cgi/access/logout')}
    />
  );
}

/** Signed in with Cloudflare Access, but not on this MailCellar's list. */
export function NotInvited({ email }: { email: string }) {
  return (
    <Empty className="min-h-[50vh]">
      <EmptyHeader>
        <EmptyMedia variant="icon"><UserXIcon /></EmptyMedia>
        <EmptyTitle>You’re not on the list</EmptyTitle>
        <EmptyDescription>
          {email} isn’t allowed in this MailCellar. Ask its admin to add you, or sign out and use another address.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" asChild>
          <a href="/cdn-cgi/access/logout"><LogOutIcon />Sign out</a>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
