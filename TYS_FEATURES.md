## Unorganized list of features:

1. Diff viewer - I use delta personally for all my jj and git diff action. I'd like to be able to easily click into some of the diffs
   to get details.I want a very "pretty experience here.

- Pretty diff.
- Opportunity to leave inline comments on PR. Really a whole PR review toolkit right there, leaving reviews or single comments.

2. Author View and general Sorting - I like that we can filter by epics - that's great! Sometimes though we don't have epics, or that's not the most useful thing.

- WE should build a better overall filtering mechanism,
- Authors
- Filter by created at date, or opened longest - maybe we raise the PR's flag vertically

3. Notifications.

- On a Per PR basis, or as a global policy, I want to set/disable notifications/alerts/and statuses for
  - Pushed Changes
  - Re-review requests
  - CI Status
- On our own PRs - you never have to mute anything, unless there's I guess a global policy.
- We should be able to clear notifications.
- Alerts should be clearable so that we cann silence stuff.

4. Watching PRs - Sometimes monorepos can get HUGE! Lots of cooks in the kitchen.

- PRs should be opt-in, we should have a dashboard or plus at the end of our little list of PR cards that lets us track new PRs
- by link
- filter by author
- filter by any recent repo activity.
- We should also maybe be able to click on a file, and if any PR opens that touches that file, or a set of files, then we'll auto-track it.
  that'll be super useful for teams that own parts of a repo.
- Need to be able to abandon watching PRs too. When they merge we should keep them around until explictly dismissed.

5.  Configureable Organization of components

- right now we have PRs at bottom, some filters at top, left side for the PR details, and right side for various metrics and buttons.
- I want configureability around where we place some of these items.

6. Color Themes - we should extablish a set of needed color items, and allow people to develop custom theming. (Not needed near term)

7. Better differentiation of PR content. (High priority) - when I zoom out to widest view, I only see a couple colors, and a few letters on the flags.

- I'm not expecting we be able to read the entire state, but if we could develop some hashed symbology and colors that combine the author, epic, ticket, etc.
  this could be really beneficial for re-identifying things.
- I do want to maybe see minimally the PR number, not the ticket number, but the PR nubmer for what's opened.

## Non-feature cleanup

1. Need a claude.md - we should establish some really good practices here for my little pet project.
2. I want to understand how someone would locally deploy this, with a chron job to live update all of the stuff.

## Delivered features;

2. DONE - should be everything we need
3. DONE
4. DONE
5. PARTIAL - Room to keep iterating, but looks good.

### LATEST REQUESTS

1. Deployment cleanup - one click install,

- Local web
- Packaged Webapp for Linux

2. Multi-repo

"An outer view we can expand to, which lets us get a view of multiple cities we're tracking.
These multiple cities are not connected, but might sit on a patch of land, generated from a hash of the repo ORG and name.
The cities just sit near eachother, evenly distributed. Our expanded view shouls show no interaction, maybe a base 3D view of the buildings,
but none of the PRs and diffs.

We'll have a small info widget showcasing some key stats

- how many PRs are we tracking in this repo?
- How many PRs do WE have open in this repo?
- How many PRs need action in this repo?

Any click ON the city should bring you into the city.

We should be able to drag cities around to a few slots, like a hexagonal Catan grid. Each city lives oon a hill of terrain (the hash determines a cute biome)
You don't get infinite placement, cities have to be near eachotther, and occupy one neihbor hexagon. Simple, pretty, but still slightly flexible.

holding over an unpolulated neighbor hex is where we get a small faint glow around the edge and a plus symbol similar to PRs, that allows
us to add a Repo by URL."

3. Local Changes;

A swap-in view of your own diffs to master, or the base head. Should work with JJ
and git. Maybe looking at your different unpushed commits/branches, or workspaces.

You would add and track a sworkspace or local change.

Open PRs under those branches should get the PR treatment. ELSE

The PR view panel and states would get ONLY a little mini git history.

No notifications in this view.

You should see how off-base you are. So when you click on a branch the whole city should change.
maybe we see the rebase deltas in some interesting way. But essentially we should get that little overview.

4. Ultra-zoom. What happens when we go realllly close into a file. Relationships, calls, references?

## Monetization Strategy

1. Open Core Design

Pulling and a public JIRA + Github (NO TOKEN) integration is free

2. Activating a license

This will let you put in a GH token and JIRA to a private org?

People will write their own clients, but that's why we make a $5 seat price so
nice that you never want to do it yourself.

3. Teaming Features.

Boards for your team which are shared and web-viewable through Org SSO.

They auto-track YOUR open PRs from a Sprint, and side-stuff get's relegated through some different filters.

Premium enterprise suppport comes with a fully custom re-skin of the appplication for your
specific enterprise.

4. We could lock the Open core to local only???

- Remove all the PR features

## Different base

Interesting.

This is all quite confusingm let's be very delicate here.

Make some jj commits that will add any baseline observability we need (the base url and stuff).

My overall philosophy here is as follows

- Don't interpret what a rebase/merge looks like. That's on developers to solve.
- Simple warnings on conflicted files should probably just show up with some new visual queue - but should NOT dominate the visuals. If PR X has a conflict on file Y, we don't need to see that from a zoomed out view.
- For moves - if PR A edits a moved file, we can display some semi transparent ghost version, with an outline framed in the color of the PR, of the old file location, even at the 10,000 foot view. That's a potentially important structural detail, and deserveds to be seen. Maybe we redraw this only when PR is focused, but we need to populate the whole city when this is done. I don't want any of this "Reserved space", side channel bullshit. That looked bad. I'll expand on this common functionality in a second.
- A Stacked PR probably has a cool visualization we can make. Maybe it should be completely hidden except for it's flag. THEN when we focus it we show a stacked state, and basically redraw the city on it's Parent state, that way the child is ONE set of changes on top. That's probably a useful system for a few of our most complex cases, maybe a toggle-able "VIEW FROM BASE" - which would mute everything and just show us ONE PR with respect to its base.
- Editing a file main deleted should probably be like some other ghost building type. Maybe that should show up ALSO only when focused? But we want a full re-draw of the city when that happens? Or maybe not?

Overall I'm thinking we need.

1. Propogate the right information
2. A triggereable re-draaw that will do ("From Base") with a url set. We won't expose this DIRECTLY to the user, but when we click into PRs we may have the option to view the change relative to their own base, or to master's. New little toggle next to the PR.
3. Whenever there's conflicts on the base, either edit conflicts, the base's file moved, deleted, etc. Then we'll use ghost buildings to display in solid where the base is, and in ghost form where the PR was trying to do stuff.

Stacked PRs should really have no viable view except for their own base. otherwise shit's too complex.
