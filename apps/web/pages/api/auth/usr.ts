import { Prisma as PrismaType } from "@prisma/client";
import type Prisma from "@prisma/client";
import { hashSync as hash } from "bcryptjs";
import type { NextApiRequest, NextApiResponse } from "next";
import { v4 } from "uuid";

import { DEFAULT_SCHEDULE, getAvailabilityFromSchedule } from "@calcom/lib/availability";
import { ProfileRepository } from "@calcom/lib/server/repository/profile";
import { prisma } from "@calcom/prisma";
import { MembershipRole, SchedulingType, TimeUnit, WorkflowTriggerEvents } from "@calcom/prisma/enums";
import type { Schedule } from "@calcom/types/schedule";

export const teamEventTitle = "Team Event - 30min";
export const teamEventSlug = "team-event-30min";

// Don't import hashPassword from app as that ends up importing next-auth and initializing it before NEXTAUTH_URL can be updated during tests.
export function hashPassword(password: string) {
  const hashedPassword = hash(password, 12);
  return hashedPassword;
}

const userIncludes = PrismaType.validator<PrismaType.UserInclude>()({
  eventTypes: true,
  workflows: true,
  credentials: true,
  routingForms: true,
});

const userWithEventTypes = PrismaType.validator<PrismaType.UserArgs>()({
  include: userIncludes,
});

const seededForm = {
  id: "948ae412-d995-4865-875a-48302588de03",
  name: "Seeded Form - Pro",
};

export enum TimeZoneEnum {
  USA = "America/New York",
  UK = "Europe/London",
}

const createTeamWorkflow = async (user: { id: number }, team: { id: number }) => {
  return await prisma.workflow.create({
    data: {
      name: "Team Workflow",
      trigger: WorkflowTriggerEvents.BEFORE_EVENT,
      time: 24,
      timeUnit: TimeUnit.HOUR,
      userId: user.id,
      teamId: team.id,
    },
  });
};

const createTeamEventType = async (
  user: { id: number },
  team: { id: number },
  scenario?: {
    schedulingType?: SchedulingType;
    teamEventTitle?: string;
    teamEventSlug?: string;
    teamEventLength?: number;
  }
) => {
  return await prisma.eventType.create({
    data: {
      team: {
        connect: {
          id: team.id,
        },
      },
      users: {
        connect: {
          id: user.id,
        },
      },
      owner: {
        connect: {
          id: user.id,
        },
      },
      hosts: {
        create: {
          userId: user.id,
          isFixed: scenario?.schedulingType === SchedulingType.COLLECTIVE ? true : false,
        },
      },
      schedulingType: scenario?.schedulingType ?? SchedulingType.COLLECTIVE,
      title: scenario?.teamEventTitle ?? `${teamEventTitle}-team-id-${team.id}`,
      slug: scenario?.teamEventSlug ?? `${teamEventSlug}-team-id-${team.id}`,
      length: scenario?.teamEventLength ?? 30,
    },
  });
};

const createTeamAndAddUser = async (
  {
    user,
    isUnpublished,
    isOrg,
    isOrgVerified,
    hasSubteam,
    organizationId,
  }: {
    user: { id: number; email: string; username: string | null; role?: MembershipRole };
    isUnpublished?: boolean;
    isOrg?: boolean;
    isOrgVerified?: boolean;
    hasSubteam?: true;
    organizationId?: number | null;
  },
  workerName: string
) => {
  const slug = `${isOrg ? "org" : "team"}-${workerName}-${Date.now()}`;
  const data: PrismaType.TeamCreateInput = {
    name: `user-id-${user.id}'s ${isOrg ? "Org" : "Team"}`,
    isOrganization: isOrg,
  };
  data.metadata = {
    ...(isUnpublished ? { requestedSlug: slug } : {}),
  };
  if (isOrg) {
    data.organizationSettings = {
      create: {
        isOrganizationVerified: !!isOrgVerified,
        orgAutoAcceptEmail: user.email.split("@")[1],
        isOrganizationConfigured: false,
      },
    };
  }

  data.slug = !isUnpublished ? slug : undefined;
  if (isOrg && hasSubteam) {
    const team = await createTeamAndAddUser({ user }, workerName);
    await createTeamEventType(user, team);
    await createTeamWorkflow(user, team);
    data.children = { connect: [{ id: team.id }] };
  }
  data.orgProfiles = isOrg
    ? {
        create: [
          {
            uid: ProfileRepository.generateProfileUid(),
            username: user.username ?? user.email.split("@")[0],
            user: {
              connect: {
                id: user.id,
              },
            },
          },
        ],
      }
    : undefined;
  data.parent = organizationId ? { connect: { id: organizationId } } : undefined;
  const team = await prisma.team.create({
    data,
  });

  const { role = MembershipRole.OWNER, id: userId } = user;
  await prisma.membership.create({
    data: {
      teamId: team.id,
      userId,
      role: role,
      accepted: true,
    },
  });

  return team;
};

type SupportedTestEventTypes = PrismaType.EventTypeCreateInput & {
  _bookings?: PrismaType.BookingCreateInput[];
};

type SupportedTestWorkflows = PrismaType.WorkflowCreateInput;

type CustomUserOptsKeys =
  | "username"
  | "completedOnboarding"
  | "locale"
  | "name"
  | "email"
  | "organizationId"
  | "twoFactorEnabled"
  | "disableImpersonation"
  | "role";
type CustomUserOpts = Partial<Pick<Prisma.User, CustomUserOptsKeys>> & {
  timeZone?: TimeZoneEnum;
  eventTypes?: SupportedTestEventTypes[];
  workflows?: SupportedTestWorkflows[];
  // ignores adding the worker-index after username
  useExactUsername?: boolean;
  roleInOrganization?: MembershipRole;
  schedule?: Schedule;
  password?: string | null;
  emailDomain?: string;
};

const createUser = (
  workerName: string,
  opts?:
    | (CustomUserOpts & {
        organizationId?: number | null;
      })
    | null
): PrismaType.UserUncheckedCreateInput => {
  // build a unique name for our user
  const uname =
    opts?.useExactUsername && opts?.username
      ? opts.username
      : `${opts?.username || "user"}-${workerName}-${Date.now()}`;

  const emailDomain = opts?.emailDomain || "example.com";
  return {
    username: uname,
    name: opts?.name,
    email: opts?.email ?? `${uname}@${emailDomain}`,
    password: {
      create: {
        hash: hashPassword(uname),
      },
    },
    emailVerified: new Date(),
    completedOnboarding: opts?.completedOnboarding ?? true,
    timeZone: opts?.timeZone ?? TimeZoneEnum.UK,
    locale: opts?.locale ?? "en",
    role: opts?.role ?? "USER",
    twoFactorEnabled: opts?.twoFactorEnabled ?? false,
    disableImpersonation: opts?.disableImpersonation ?? false,
    ...getOrganizationRelatedProps({ organizationId: opts?.organizationId, role: opts?.roleInOrganization }),
    schedules:
      opts?.completedOnboarding ?? true
        ? {
            create: {
              name: "Working Hours",
              timeZone: opts?.timeZone ?? TimeZoneEnum.UK,
              availability: {
                createMany: {
                  data: getAvailabilityFromSchedule(opts?.schedule ?? DEFAULT_SCHEDULE),
                },
              },
            },
          }
        : undefined,
  };

  function getOrganizationRelatedProps({
    organizationId,
    role,
  }: {
    organizationId: number | null | undefined;
    role: MembershipRole | undefined;
  }) {
    if (!organizationId) {
      return null;
    }
    if (!role) {
      throw new Error("Missing role for user in organization");
    }
    return {
      organizationId,
      profiles: {
        create: {
          uid: ProfileRepository.generateProfileUid(),
          username: uname,
          organization: {
            connect: {
              id: organizationId,
            },
          },
        },
      },
      teams: {
        // Create membership
        create: [
          {
            team: {
              connect: {
                id: organizationId,
              },
            },
            accepted: true,
            role: MembershipRole.ADMIN,
          },
        ],
      },
    };
  }
};

export const createTestUser = async (
  opts?:
    | (CustomUserOpts & {
        organizationId?: number | null;
      })
    | null,
  scenario: {
    seedRoutingForms?: boolean;
    hasTeam?: true;
    teamRole?: MembershipRole;
    teammates?: CustomUserOpts[];
    schedulingType?: SchedulingType;
    teamEventTitle?: string;
    teamEventSlug?: string;
    teamEventLength?: number;
    isOrg?: boolean;
    isOrgVerified?: boolean;
    hasSubteam?: true;
    isUnpublished?: true;
  } = {},
  workerName = "69"
) => {
  const _user = await prisma.user.create({
    data: createUser(workerName, opts),
    include: {
      profiles: true,
    },
  });

  let defaultEventTypes: SupportedTestEventTypes[] = [
    { title: "30 min", slug: "30-min", length: 30 },
    { title: "Paid", slug: "paid", length: 30, price: 1000 },
    { title: "Opt in", slug: "opt-in", requiresConfirmation: true, length: 30 },
    { title: "Seated", slug: "seated", seatsPerTimeSlot: 2, length: 30 },
  ];

  if (opts?.eventTypes) defaultEventTypes = defaultEventTypes.concat(opts.eventTypes);
  for (const eventTypeData of defaultEventTypes) {
    eventTypeData.owner = { connect: { id: _user.id } };
    eventTypeData.users = { connect: { id: _user.id } };
    if (_user.profiles[0]) {
      eventTypeData.profile = { connect: { id: _user.profiles[0].id } };
    }
    await prisma.eventType.create({
      data: eventTypeData,
    });
  }

  const workflows: SupportedTestWorkflows[] = [
    { name: "Default Workflow", trigger: "NEW_EVENT" },
    { name: "Test Workflow", trigger: "EVENT_CANCELLED" },
    ...(opts?.workflows || []),
  ];
  for (const workflowData of workflows) {
    workflowData.user = { connect: { id: _user.id } };
    await prisma.workflow.create({
      data: workflowData,
    });
  }

  if (scenario.seedRoutingForms) {
    await prisma.app_RoutingForms_Form.create({
      data: {
        routes: [
          {
            id: "8a898988-89ab-4cde-b012-31823f708642",
            action: { type: "eventTypeRedirectUrl", value: "pro/30min" },
            queryValue: {
              id: "8a898988-89ab-4cde-b012-31823f708642",
              type: "group",
              children1: {
                "8988bbb8-0123-4456-b89a-b1823f70c5ff": {
                  type: "rule",
                  properties: {
                    field: "c4296635-9f12-47b1-8153-c3a854649182",
                    value: ["event-routing"],
                    operator: "equal",
                    valueSrc: ["value"],
                    valueType: ["text"],
                  },
                },
              },
            },
          },
          {
            id: "aa8aaba9-cdef-4012-b456-71823f70f7ef",
            action: { type: "customPageMessage", value: "Custom Page Result" },
            queryValue: {
              id: "aa8aaba9-cdef-4012-b456-71823f70f7ef",
              type: "group",
              children1: {
                "b99b8a89-89ab-4cde-b012-31823f718ff5": {
                  type: "rule",
                  properties: {
                    field: "c4296635-9f12-47b1-8153-c3a854649182",
                    value: ["custom-page"],
                    operator: "equal",
                    valueSrc: ["value"],
                    valueType: ["text"],
                  },
                },
              },
            },
          },
          {
            id: "a8ba9aab-4567-489a-bcde-f1823f71b4ad",
            action: { type: "externalRedirectUrl", value: "https://google.com" },
            queryValue: {
              id: "a8ba9aab-4567-489a-bcde-f1823f71b4ad",
              type: "group",
              children1: {
                "998b9b9a-0123-4456-b89a-b1823f7232b9": {
                  type: "rule",
                  properties: {
                    field: "c4296635-9f12-47b1-8153-c3a854649182",
                    value: ["external-redirect"],
                    operator: "equal",
                    valueSrc: ["value"],
                    valueType: ["text"],
                  },
                },
              },
            },
          },
          {
            id: "aa8ba8b9-0123-4456-b89a-b182623406d8",
            action: { type: "customPageMessage", value: "Multiselect chosen" },
            queryValue: {
              id: "aa8ba8b9-0123-4456-b89a-b182623406d8",
              type: "group",
              children1: {
                "b98a8abb-cdef-4012-b456-718262343d27": {
                  type: "rule",
                  properties: {
                    field: "d4292635-9f12-17b1-9153-c3a854649182",
                    value: [["Option-2"]],
                    operator: "multiselect_equals",
                    valueSrc: ["value"],
                    valueType: ["multiselect"],
                  },
                },
              },
            },
          },
          {
            id: "898899aa-4567-489a-bcde-f1823f708646",
            action: { type: "customPageMessage", value: "Fallback Message" },
            isFallback: true,
            queryValue: { id: "898899aa-4567-489a-bcde-f1823f708646", type: "group" },
          },
        ],
        fields: [
          {
            id: "c4296635-9f12-47b1-8153-c3a854649182",
            type: "text",
            label: "Test field",
            required: true,
          },
          {
            id: "d4292635-9f12-17b1-9153-c3a854649182",
            type: "multiselect",
            label: "Multi Select",
            identifier: "multi",
            selectText: "Option-1\nOption-2",
            required: false,
          },
        ],
        user: {
          connect: {
            id: _user.id,
          },
        },
        name: seededForm.name,
      },
    });
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: _user.id },
    include: userIncludes,
  });

  if (scenario.hasTeam) {
    const team = await createTeamAndAddUser(
      {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: scenario.teamRole || "OWNER",
        },
        isUnpublished: scenario.isUnpublished,
        isOrg: scenario.isOrg,
        isOrgVerified: scenario.isOrgVerified,
        hasSubteam: scenario.hasSubteam,
        organizationId: opts?.organizationId,
      },
      workerName
    );

    const teamEvent = await createTeamEventType(user, team, scenario);
    if (scenario.teammates) {
      // Create Teammate users
      const teamMates = [];
      for (const teammateObj of scenario.teammates) {
        const teamUser = await prisma.user.create({
          data: createUser(workerName, teammateObj),
        });

        // Add teammates to the team
        await prisma.membership.create({
          data: {
            teamId: team.id,
            userId: teamUser.id,
            role: MembershipRole.MEMBER,
            accepted: true,
          },
        });

        // Add teammate to the host list of team event
        await prisma.host.create({
          data: {
            userId: teamUser.id,
            eventTypeId: teamEvent.id,
            isFixed: scenario.schedulingType === SchedulingType.COLLECTIVE ? true : false,
          },
        });

        teamMates.push(teamUser);
      }
      // Add Teammates to OrgUsers
      if (scenario.isOrg) {
        const orgProfilesCreate = teamMates
          .map((teamUser) => ({
            user: {
              connect: {
                id: teamUser.id,
              },
            },
            uid: v4(),
            username: teamUser.username || teamUser.email.split("@")[0],
          }))
          .concat([
            {
              user: { connect: { id: user.id } },
              uid: v4(),
              username: user.username || user.email.split("@")[0],
            },
          ]);

        const existingProfiles = await prisma.profile.findMany({
          where: {
            userId: _user.id,
          },
        });

        await prisma.team.update({
          where: {
            id: team.id,
          },
          data: {
            orgProfiles: _user.profiles.length
              ? {
                  connect: _user.profiles.map((profile) => ({ id: profile.id })),
                }
              : {
                  create: orgProfilesCreate.filter(
                    (profile) => !existingProfiles.map((p) => p.userId).includes(profile.user.connect.id)
                  ),
                },
          },
        });
      }
    }
  }

  return user;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await createTestUser();

  res.status(200).json({ message: "User created", user });
}
