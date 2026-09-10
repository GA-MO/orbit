import { createRoot } from 'react-dom/client'
import '../styles.css'
import './gallery.css'

import {
  Button,
  EmptyState,
  Field,
  IconBack,
  IconBranch,
  IconCapture,
  IconChevronDown,
  IconClose,
  IconDisplay,
  IconEdit,
  IconExternal,
  IconFolder,
  IconHome,
  IconImage,
  IconInsert,
  IconLink,
  IconMic,
  IconPaste,
  IconPlus,
  IconRestart,
  IconSearch,
  IconSessions,
  IconTerminal,
  IconTrash,
  IconButton,
  OrbitMark,
  Segmented,
  Sheet,
} from '../components/ui'
import AskModal from '../components/AskModal'
import ApprovalModal from '../components/ApprovalModal'
import NoticeOptIn from '../components/NoticeOptIn'
import PageViewer from '../components/PageViewer'
import { noticePermission } from '../notice'

import { Aside, Both, Cell, Label, Pad, Screen, Section } from './scaffold'
import { Tokens } from './tokens'
import {
  APPROVAL_LONG,
  APPROVAL_SHORT,
  ASK_FOUR,
  ASK_LONG,
  ASK_NO_SOURCE,
  ASK_TWO,
} from './fixtures'

const noop = () => {}

const ICON_BUTTON_SIZES = ['sm', 'md', 'lg'] as const
const GLYPH_SIZE_FOR: Record<(typeof ICON_BUTTON_SIZES)[number], number> = {
  sm: 14,
  md: 17,
  lg: 20,
}

const SEG_TWO = [
  { id: 'live', label: 'Live' },
  { id: 'ended', label: 'Ended' },
]

const SEG_THREE = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'changes', label: 'Changes' },
  { id: 'captures', label: 'Captures' },
]

const SEG_LONG = [
  { id: 'unstaged', label: 'Unstaged' },
  { id: 'staged', label: 'Staged' },
  { id: 'untracked', label: 'Untracked' },
  { id: 'conflicted', label: 'Conflicted' },
]

function MarkSection() {
  return (
    <Both label="OrbitMark">
      <div className="grid grid-cols-4 gap-2 p-4">
        <Cell name="20">
          <OrbitMark size={20} />
        </Cell>
        <Cell name="28 (default)">
          <OrbitMark />
        </Cell>
        <Cell name="44">
          <OrbitMark size={44} />
        </Cell>
        <Cell name="44 halo">
          <OrbitMark size={44} halo />
        </Cell>
        <Cell name="28 idle">
          <OrbitMark size={28} idle />
        </Cell>
        <Cell name="44 idle halo">
          <OrbitMark size={44} idle halo />
        </Cell>
        <Cell name="72 halo">
          <OrbitMark size={72} halo />
        </Cell>
        <Cell name="72 idle">
          <OrbitMark size={72} idle />
        </Cell>
      </div>
    </Both>
  )
}

const ICONS = [
  ['IconTerminal', IconTerminal],
  ['IconSessions', IconSessions],
  ['IconCapture', IconCapture],
  ['IconMic', IconMic],
  ['IconImage', IconImage],
  ['IconPlus', IconPlus],
  ['IconBack', IconBack],
  ['IconHome', IconHome],
  ['IconFolder', IconFolder],
  ['IconBranch', IconBranch],
  ['IconRestart', IconRestart],
  ['IconTrash', IconTrash],
  ['IconEdit', IconEdit],
  ['IconInsert', IconInsert],
  ['IconPaste', IconPaste],
  ['IconDisplay', IconDisplay],
  ['IconClose', IconClose],
  ['IconLink', IconLink],
  ['IconExternal', IconExternal],
  ['IconChevronDown', IconChevronDown],
  ['IconSearch', IconSearch],
] as const

function IconGrid({ size }: { size: number }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 p-3">
      {ICONS.map(([name, Icon]) => (
        <div
          key={name}
          className="flex flex-col items-center gap-1.5 rounded-lg border border-line/40 py-2.5"
        >
          <Icon size={size} className="text-fore" />
          <span className="font-mono text-[9px] leading-none text-faint">{name.slice(4)}</span>
        </div>
      ))}
    </div>
  )
}

const VARIANTS = ['primary', 'outline', 'ghost', 'danger'] as const

function ButtonMatrix({ disabled = false }: { disabled?: boolean }) {
  return (
    <Pad>
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex items-center gap-2">
          <span className="w-16 shrink-0 font-mono text-[10px] text-faint">{variant}</span>
          <Button variant={variant} disabled={disabled}>
            Resume
          </Button>
          <Button variant={variant} disabled={disabled}>
            <IconRestart size={16} />
            With icon
          </Button>
        </div>
      ))}
    </Pad>
  )
}

function FieldStates({ focused = false }: { focused?: boolean }) {
  return (
    <Pad>
      <div>
        <Label>placeholder</Label>
        <Field placeholder="Search captures" />
      </div>
      <div>
        <Label>filled</Label>
        <Field defaultValue="~/Development/orbit" />
      </div>
      <div>
        <Label>{focused ? 'focused' : 'focused — dark frame only'}</Label>
        <Field autoFocus={focused} defaultValue="rename this session" />
      </div>
      <div>
        <Label>error (composed by the caller)</Label>
        <Field
          defaultValue="not-a-port"
          className="border-danger focus:border-danger focus:shadow-[inset_0_1px_3px_rgb(0_0_0/0.4),0_0_0_3px_rgb(243_115_123/0.22)]"
        />
        <p className="mt-1.5 text-xs text-danger">Ports are numbers between 1 and 65535</p>
      </div>
      <div>
        <Label>disabled</Label>
        <Field disabled defaultValue="locked while the session starts" />
      </div>
    </Pad>
  )
}

function SheetBody() {
  return (
    <div className="flex flex-col gap-3 px-5 pt-3 pb-6">
      <p className="text-sm text-mut">
        A sheet holds a decision that would be rude to take over the whole screen — picking a
        directory, naming a session, choosing what to send.
      </p>
      <Field placeholder="Name this session" />
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1">
          Cancel
        </Button>
        <Button className="flex-1">Start</Button>
      </div>
    </div>
  )
}

function Gallery() {
  const noticeState = noticePermission()

  return (
    <div className="min-h-full bg-ink pb-24">
      <header className="flex items-center gap-4 px-6 py-8">
        <OrbitMark size={40} halo />
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-wide text-fore">
            Orbit — states gallery
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mut">
            Every primitive in every state, drawn without a server, a token, or a phone. Each
            specimen sits in a 390px frame — the real target — and again on a pale ground, because
            Orbit ships no light palette and this is the only place that fact is visible.
          </p>
        </div>
      </header>

      <Section
        title="Tokens"
        note="Read out of the running stylesheet rather than typed in, so this list cannot drift from the app."
      >
        <Tokens />
      </Section>

      <Section
        title="OrbitMark"
        note="The satellite spins; `idle` parks it and drops the ring's glow. `halo` is cast light for the one place the mark is shown large, and is declared after idle so a large idle mark still glows faintly."
      >
        <MarkSection />
      </Section>

      <Section
        title="Icons"
        note="The whole set at 20px and again at 17px, the size the dense header rows use. The pale frame is expected to be all but empty: icons inherit --color-fore, which is near-white, so a light surface is the one place they cannot be drawn at all."
      >
        <Screen label="20px">
          <IconGrid size={20} />
        </Screen>
        <Screen label="17px">
          <IconGrid size={17} />
        </Screen>
        <Screen label="17px · pale ground" ground="light">
          <IconGrid size={17} />
        </Screen>
      </Section>

      <Section
        title="Button"
        note="Only primary is lit — it is the one control on a screen that does the thing. Disabled is opacity alone, which is worth looking at hard on ghost, where there was little to fade in the first place."
      >
        <Both label="enabled">
          <ButtonMatrix />
        </Both>
        <Screen label="disabled">
          <ButtonMatrix disabled />
        </Screen>
        <Screen label="busy · long label · full width">
          <Pad>
            <Button disabled>Asking…</Button>
            <Button variant="outline" disabled>
              Publishing to the tailnet…
            </Button>
            <Button className="w-full">Full width</Button>
            <Button variant="danger" className="w-full">
              Discard every change in orbit-preview-tailscale-serve-controller
            </Button>
          </Pad>
        </Screen>
      </Section>

      <Section
        title="IconButton"
        note="sm and md are drawn small and tapped at 44px — the dashed amber outline is the hit area those two grow around themselves, normally invisible. lg is already 44 and is left alone rather than made greedy."
      >
        <Both label="sizes" showHits>
          <Pad>
            {ICON_BUTTON_SIZES.map((size) => (
              <div key={size} className="flex items-center gap-4 py-1.5">
                <span className="w-8 shrink-0 font-mono text-[10px] text-faint">{size}</span>
                <IconButton label="Close" size={size}>
                  <IconClose size={GLYPH_SIZE_FOR[size]} />
                </IconButton>
                <IconButton label="Trash" size={size} disabled>
                  <IconTrash size={GLYPH_SIZE_FOR[size]} />
                </IconButton>
                <span className="font-mono text-[10px] text-faint">enabled · disabled</span>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-0.5 border-t border-line/50 pt-4">
              <IconButton label="Close">
                <IconClose size={18} />
              </IconButton>
              <span className="min-w-0 flex-1 truncate px-1 font-mono text-xs text-mut">
                a dense header row
              </span>
              <IconButton label="Reload">
                <IconRestart size={17} />
              </IconButton>
              <IconButton label="Capture">
                <IconCapture size={17} />
              </IconButton>
              <IconButton label="Copy link">
                <IconLink size={17} />
              </IconButton>
            </div>
          </Pad>
        </Both>
      </Section>

      <Section
        title="Field"
        note="The focus ring is a real :focus, put there by autoFocus rather than mimicked with a class — which is exactly why only the dark frame can show it. A document has one focused element, so the pale copy is drawn unfocused and says so."
      >
        <Screen label="states">
          <FieldStates focused />
        </Screen>
        <Screen label="states · pale ground" ground="light">
          <FieldStates />
        </Screen>
      </Section>

      <Section
        title="Segmented"
        note="Static instances rather than one that toggles: each selection is its own specimen, so a screenshot catches all of them."
      >
        <Both label="selection">
          <Pad className="items-start">
            <Segmented value="live" options={SEG_TWO} onChange={noop} />
            <Segmented value="ended" options={SEG_TWO} onChange={noop} />
            <Segmented value="changes" options={SEG_THREE} onChange={noop} />
            <Segmented value="staged" options={SEG_LONG} onChange={noop} />
          </Pad>
        </Both>
      </Section>

      <Section title="EmptyState" note="Always with the idle mark and its halo — the app's quietest screen is still lit.">
        <Both label="title only">
          <EmptyState title="No captures yet" />
        </Both>
        <Screen label="hint + action">
          <EmptyState
            title="Nothing is running"
            hint="Start a session on the desktop, or from here, and it will appear in this list within a few seconds."
          >
            <Button>
              <IconPlus size={16} />
              New session
            </Button>
          </EmptyState>
        </Screen>
        <Screen label="long hint">
          <EmptyState
            title="No published ports"
            hint="A dev server on the desktop can be published to the tailnet over https, which is the only way an installed web app is allowed to frame it. Nothing is listening right now."
          />
        </Screen>
      </Section>

      <Section
        title="Sheet"
        note="Rendered open. The scrim is blurred and the panel is not — deliberately, so WebKit re-samples one full-screen layer over a canvas that never stops repainting, rather than two."
      >
        <Screen label="bottom, with title" height={540}>
          <Sheet title="New session" onClose={noop}>
            <SheetBody />
          </Sheet>
        </Screen>
        <Screen label="bottom, untitled" height={540}>
          <Sheet onClose={noop}>
            <SheetBody />
          </Sheet>
        </Screen>
        <Screen label="full" height={540}>
          <Sheet side="full" title="Pick a directory" onClose={noop}>
            <SheetBody />
          </Sheet>
        </Screen>
        <Screen label="bottom · pale ground" ground="light" height={540}>
          <Sheet title="New session" onClose={noop}>
            <SheetBody />
          </Sheet>
        </Screen>
      </Section>

      <Section
        title="AskModal"
        note="The state that is hardest to reach for real: something on the desktop is blocked until this is answered, so there is no dismiss and every path answers. Two options read as a decision and sit reversed so the emphasised one is under the thumb; more than two stack."
      >
        <Screen label="two options" height={420}>
          <AskModal request={ASK_TWO} onAnswer={noop} />
        </Screen>
        <Screen label="four long options" height={480}>
          <AskModal request={ASK_FOUR} onAnswer={noop} />
        </Screen>
        <Screen label="long question + unbreakable detail" height={480}>
          <AskModal request={ASK_LONG} onAnswer={noop} />
        </Screen>
        <Screen label="no options, no source (fallback)" height={300}>
          <AskModal request={ASK_NO_SOURCE} onAnswer={noop} />
        </Screen>
        <Screen label="four options · 720 wide" width={720} height={420}>
          <AskModal request={ASK_FOUR} onAnswer={noop} />
        </Screen>
        <Screen label="two options · pale ground" ground="light" height={420}>
          <AskModal request={ASK_TWO} onAnswer={noop} />
        </Screen>
      </Section>

      <Section
        title="ApprovalModal"
        note="The same shape in danger red. The long command is the case worth looking at — a command that must break mid-token to fit, next to two buttons that must not."
      >
        <Screen label="short command" height={360}>
          <ApprovalModal request={APPROVAL_SHORT} onApprove={noop} onDeny={noop} />
        </Screen>
        <Screen label="long label + long command" height={440}>
          <ApprovalModal request={APPROVAL_LONG} onApprove={noop} onDeny={noop} />
        </Screen>
        <Screen label="long · pale ground" ground="light" height={440}>
          <ApprovalModal request={APPROVAL_LONG} onApprove={noop} onDeny={noop} />
        </Screen>
      </Section>

      <Section
        title="NoticeOptIn"
        note="A banner that removes itself the moment it is answered, which makes it invisible to anyone who has already answered — including whoever is reviewing it."
      >
        {noticeState === 'default' ? (
          <Both label="offering">
            <div className="py-4">
              <NoticeOptIn onToast={noop} />
            </div>
          </Both>
        ) : (
          <Aside>
            NoticeOptIn is drawing nothing here: it returns null unless the browser reports
            permission <code className="font-mono">default</code>, and this one reports{' '}
            <code className="font-mono">{noticeState}</code>. Over plain http on a LAN address
            there is no secure context, so <code className="font-mono">navigator.serviceWorker</code>{' '}
            does not exist and the component is right to hide. Open this page on{' '}
            <code className="font-mono">localhost:5173</code> to review it.
          </Aside>
        )}
      </Section>

      <Section
        title="PageViewer"
        note="The header is the reviewable part. Its iframe points at a dev server that is not running, on purpose — a live page inside this frame would make every screenshot of this gallery depend on somebody else's app."
      >
        <Screen label="with insert + toast" height={560}>
          <PageViewer
            uri="https://127.0.0.1:8443/dashboard"
            label="dashboard"
            onClose={noop}
            onInsertPath={noop}
            onToast={noop}
          />
        </Screen>
        <Screen label="without insert (no capture button)" height={560}>
          <PageViewer uri="https://127.0.0.1:8443/a/very/long/path/that/has/to/truncate/somewhere/eventually" onClose={noop} />
        </Screen>
      </Section>

      <Section
        title="Views"
        note="Empty on purpose — the three list views are mid-rewrite. When they settle, each wants a fixed-height Screen fed from hand-written rows in fixtures.ts, never a fetch."
      >
        <Aside>
          CapturesView, SessionsView and ChangesView are being rewritten right now. Their stories
          land after, fed from fixtures rather than the API.
        </Aside>
      </Section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Gallery />)
