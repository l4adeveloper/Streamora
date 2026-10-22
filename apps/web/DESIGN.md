# Streamora visual language — Material 3 Expressive

## Home entry screen

The home route renders a fixed, viewport-height illustrated poster with a brand
header, theme control, centred headline, and one “Bắt đầu” link to `/login`.
There is no embedded authentication form or workspace UI. `entry-page.css`
scopes the scroll lock to home and recomposes the artwork for phones and tablets.

The existing `/login` and `/register` forms retain validation, password visibility,
request deduplication, pending states, and registration confirmation. Successful
logins and authenticated visits to an auth form redirect to `/workspace`.
Profile editing remains available at `/account`.

`src/components/study-banner.tsx` draws the poster directly in editable SVG:
a fan of folded book pages, a coral idea flower, a conversation mark and a
paper plane connected by a fine flowing line. Warm paper, cobalt blue, coral
and yellow balance the large central typography. Colours adapt to dark mode;
there are no generated/raster images, device screens or workspace mockups.

Page text follows the book's curved perspective and is clipped to its own paper
surface beneath the overlapping folds. The bookmark emerges from the spine;
the flower stem starts behind the petals and both leaves join it at explicit
nodes. The Start label is centred independently of its trailing arrow.
The flower sways by 3.5 degrees each way, the plane floats by 26 SVG units
vertically and 12 horizontally with 3 degrees of rotation, and the conversation
mark rises by 18, on smooth 10–14 second loops. Text and controls stay
still. The whole book rises by 18 SVG units and rocks by 1.25 degrees each way
over 10 seconds, while two inner sheets gently fan around their shared spine
on 8 and 9 second loops. The covers, printed lines and bookmark travel together;
the page pivots stay attached to the spine. All loops stop under
`prefers-reduced-motion`.

Visual checks cover both themes at six viewport sizes, including 320px portrait,
tablet and short landscape, with no document overflow. The authentication
regression follows home → “Bắt đầu” → login → workspace and checks that an
existing session still reaches the workspace through the same action.

## Dropdowns and interaction motion

`common/selects.css` themes native single-value selects and their pickers using
`appearance: base-select` in supporting browsers. Speed, quality, sharing FPS,
and membership roles share elevated menu surfaces, 12px corners, subtle shadows,
selected-state checkmarks, hover/focus colors, and a rotating chevron. Existing
select values, labels, disabled states, and change handlers remain intact.
Browsers without this styling API retain the original native picker. Reference:
https://developer.chrome.com/blog/a-customizable-select.

Opening and closing use a 160ms fade with 4px travel. The workspace dialog's
Escape handler lets an open select dismiss first, preserving the enclosing
dialog. A dedicated browser regression checks keyboard selection, picker
dismissal, persisted FPS selection, and subsequent dialog dismissal.

`InteractionFeedback` draws a transient, clipped state layer outside React-owned
control children. Pointer and keyboard presses receive a 360ms wash; buttons
compress to 0.97 while pressed and return over 180ms. Form-mode changes fade in
with 4px of travel over 180ms. These effects do not change layout or handlers.
Disabled controls are excluded. Route changes and preference changes cancel and
clean up feedback, and reduced-motion mode disables both scripted and CSS motion.

The current visual system follows Google's Material 3 Expressive language,
using a blue seed palette and tonal surfaces. Google documents this evolution
as Material 3 Expressive, rather than Material Design 4:
https://m3.material.io/ and
https://design.google/library/expressive-material-design-google-research.

The refinements change presentation: CSS, locally served fonts, font preloads,
and the casing of navigation/table labels. Existing dark-mode test color
expectations follow the palette; application behavior remains unchanged.

## Audit and scope

The original frontend used a dark palette with hardcoded colors across the global,
authentication, groups, memberships, and common stylesheets. Typography used Be
Vietnam Pro, several intermediate weights, and many 6–10px interface labels.
Mobile styles reduced text further. Purple gradients, large shadows, floating
hover effects, and inconsistent corner radii competed with the content.

The refinement keeps the existing routes, panel widths, navigation hierarchy,
breakpoints, component structure, state, permissions, API calls, and data flows.
Changes are presentation styles, inline color tokens, and the brand icon stroke.

## Tokens and components

`src/app/tokens.css` defines the shared palette, Google Sans Flex typography, 4px spacing
rhythm, shape scale, focus ring, motion easing, and elevation shadows. The old
`--violet`, `--cyan`, and `--green` names remain aliases for existing components.
Use semantic names for new styles.

- White content, near-neutral cool sidebars, and a distinct neutral navigation
  rail. Dark mode uses charcoal surfaces with the same semantic roles.
- Blue primary actions and tonal selected navigation, with sky and mint secondary
  containers. Every container has a matching foreground token in both themes.
- 24/32 page titles, 18/26 sections, 14/20 component headings, 14/22 body,
  13/18 secondary text, and 12/16 metadata; weights 400, 500, and 600.
- Main conversation text uses 15/24 for comfortable reading. Most labels and
  headings use 500, with body text at 400 and automatic optical sizing.
- Muted text on panels uses `--muted-on-panel` for better contrast.
- Buttons use 32–36px heights; text inputs use 38px. Playback sliders retain
  their own geometry. Native selects retain keyboard behavior.
- Full-round action buttons, icon buttons, navigation items, reactions, and
  avatars. Status badges use 4px, fields and small containers 8px, media 12px,
  cards 16px, and dialogs 24px. File glyphs have no decorative icon tiles.
- Filled primary actions, outlined secondary actions, tonal device controls,
  contained selected tabs, and blue active-tab indicators.
- Fine borders separate content surfaces. Shadows indicate floating elements
  and interactive card hover, without changing positions or panel dimensions.
- Hover, pressed, keyboard focus, disabled, loading, empty, and error states
  share the same palette. State transitions use 150ms; shape and dialog motion
  use 200ms with standard Material easing. All honor reduced motion.
- Decorative orbits and invitation flourishes are hidden. Media overlays and
  playback progress gradients remain because they convey useful information.

Embedded lesson diagrams and miniature landing previews retain their own scale;
they represent content rather than application UI labels.

## Review

Review the live workspace, chat, files, meeting setup, room, landing, login,
registration, protected-page feedback, search dialog, and mobile navigation.
Check wide desktop, compact desktop, tablet, and narrow mobile. Keep panel widths
and breakpoint behavior in their existing feature stylesheets.

For production checks while a development server is running, build a source copy
under the ignored `.preview/` directory to avoid competing over Next.js output.

### Validation performed

- Frontend TypeScript check and whitespace validation passed.
- The final production build generated all 11 static pages and all dynamic
  routes. The verification copy used one build worker to avoid intermittent
  Windows `EPERM` errors during concurrent route-directory creation; the
  application's Next.js configuration was not changed.
- Browser review covered desktop, tablet, and mobile workspace layouts, files,
  meeting setup, login, registration, mobile navigation, search results and
  Escape dismissal, and empty-login validation/focus states.
- Google Sans Flex loaded successfully; body paragraphs compute to weight 400. The
  workspace had no document-level horizontal overflow at the reviewed sizes.
- Authenticated group switching, membership permissions, and account identity
  synchronization are covered by the sidebar follow-up checks below.

Material before/after screenshots and measured bounds are saved in
`.preview/material-ui/expressive-before*` and `expressive-after*`.

## Compact workspace follow-up

`src/components/workspace-layout.css` keeps the workspace inside the viewport,
with a single 60px context bar (replacing the earlier 40px bar and 56px heading).
The live stage grows and shrinks with
the available height. Chat, navigation, lists, and supporting lesson information
retain independent scrolling where needed; the live main region and document
do not scroll. Non-workspace pages retain their normal document scrolling.

The sample slide scales as a complete 700×400 frame using a cleaned-up
`ResizeObserver`; actual screen shares retain their existing media behavior.
Desktop, laptop, mobile, and shorter-window checks verified that the document,
live main region, and slide content fit their respective bounds. Frontend
typecheck and the isolated production build passed.

## Group rail and account consolidation

The outer rail renders groups returned by the existing workspace group hook.
Selecting an icon calls the existing group selector, updates the URL and session
selection, and reloads the group's permissions and members. Static demo community
icons and local-only community creation have been replaced by real group access;
the plus action opens the existing group management page.

The current-group dropdown, duplicate Groups overview link, invitation card,
and separate profile icon are removed. One account footer spans both sidebars,
with the user's actual avatar initials, name, session status, microphone, and
settings. On narrow screens it collapses to the same account avatar and expands
with channel navigation.

Validation: all four membership browser tests passed, including rail selection,
exclusion of unjoined groups, permission changes, reload/navigation persistence,
member-list isolation, and mobile bounds. The focused account synchronization
test also passed for profile updates and logout across tabs. These tests build
an isolated production frontend and use disposable databases. Typecheck passed.
Screenshots: `.preview/workspace-groups-desktop.png` and
`.preview/workspace-groups-mobile.png`.

## Navigation and chat follow-up

Workspace links exit the overview member view, including links to the route
already open. Route changes reconcile that view with explicit `tab=members`
deep links. Active channel styles no longer remain selected behind the member
overview. Breadcrumbs show the selected group and current channel, classroom,
room, meeting setup, files, recordings, or member overview.

`WorkspaceChat` gives each conversation its own scrolling history and places
the composer outside that region. Both the main channel and side chat use this
component. Scrolling to new messages targets only the conversation history and
respects reduced motion, without moving the composer or the workspace shell.

`MembersPanel` shows a read-only directory by default. Only the overview opts in
through `allowManagement` for adding, changing roles, and removing members; the
existing server permissions still apply. The right panel retains member search,
role badges, and its independently scrolling directory, including for admins.

Regression checks cover exiting the member overview for all workspace routes,
breadcrumb/active-item consistency, the add-form placement, and a 60-message
history with a fixed composer during scrolling/sending on desktop and mobile.

## Unified workspace header

The breadcrumb is the page heading. Invitation and member-panel controls now
share the context bar with search and notifications; the sample-space label,
demo avatar, duplicate channel heading, and subtitle are removed. The bar is
60px high across breakpoints, with 14px breadcrumb text, 18px action icons, and
36px controls. Narrow screens use labeled icon buttons for invitation/back
actions. The mobile member overlay starts below the same shared height token.

## Optional Material dark palette

The header includes a keyboard-accessible moon/sun toggle with an announced
pressed state. The dark palette uses `#1b1b1f` background,
`#202124` sidebar, and `#a8c7fa` blue in the existing semantic tokens, including
forms, menus, dialogs, account surfaces, and status colors. Primary buttons use
dark text on blue to preserve readable contrast. Geometry remains unchanged.
Danger actions use a dedicated `--on-danger` foreground in both themes.

The preference is saved locally and applied by a small initialization script in
the root document head before the body paints. The workspace toggle also listens
for preference changes from other tabs. Storage failures do not prevent toggling.
Light mode remains the default for a browser without a saved preference.

Validation: all seven membership/workspace browser tests and TypeScript passed.
The new check covers keyboard input, dark dialog surfaces, reloads, workspace
navigation, tab synchronization, hydration, and header bounds at 390px and 320px.
Screenshots: `.preview/workspace-dark-mode.png` and
`.preview/workspace-dark-mode-mobile.png`.

The same toggle is available beside the account action on the landing page and
in the shared header for authentication, account, and group pages. It stays
visible when mobile navigation links collapse. The focused theme regression
passes for landing-to-workspace navigation, tab synchronization with the landing
page, and toggling in the login header; TypeScript also passes.

## Material refinement validation

- Frontend TypeScript and whitespace checks pass.
- All seven existing membership/workspace browser regressions pass, using the
  fixture's isolated production build and disposable test database.
- Reviewed 88 route/theme/viewport combinations: 11 routes, both themes, and
  widths 1440, 768, 390, and 320px. No document-level horizontal overflow.
- Workspace rail, sidebar, topbar, main content, and right panel bounds match
  the captured baseline. Font metrics naturally change text wrapping and content
  heights on some narrow public/auth pages; layout rules are preserved.
- Additional browser checks pass for form focus/errors/password visibility,
  disabled hover states, chat sending, search and Escape dismissal, file filters,
  mobile navigation, loaded Google Sans Flex fonts, and reduced motion.
- All 24 checked semantic text/background pairs meet WCAG AA's 4.5:1 contrast
  threshold across light and dark themes. No browser page errors were observed.

## Product detail refinement

Google Sans Flex is served from `public/fonts/` with its OFL license. Latin and
Vietnamese subsets preload from the same origin; Latin Extended loads on demand.
The supplied Unicode ranges keep Vietnamese accents in the same font family.
Browser inspection confirmed the actual rendered glyphs use Google Sans Flex,
and the interaction checks observed no Google Fonts/CDN requests.

This pass reduces unnecessary color containers, heavy headings, outline noise,
and pill shapes on non-interactive labels. Navigation labels and file-table
headings use sentence case. Message spacing, tabular timestamps, single-line
file sizes, focus outlines, and player-label placement receive individual checks.

Before/after captures and bounds for the detail pass are stored in
`.preview/material-ui/polish-before*` and `polish-after*`. All 88 view combinations
passed without horizontal overflow, and all workspace shell/panel bounds match
the baseline. The seven existing regressions pass with an isolated production
build; the additional interaction checks pass in both themes, including 24 text
contrast pairs, reduced motion, and local font loading.
