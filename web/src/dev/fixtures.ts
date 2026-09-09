import type { AskRequest, ApprovalRequest } from '../Terminal'

const LONG_QUESTION =
  'The migration will drop the sessions table and rebuild it from the transcript ' +
  'archive, which takes about four minutes and cannot be interrupted once it has ' +
  'begun. Shall I go ahead now, or wait until the running agents have finished?'

const UNBREAKABLE = 'orbit-preview-tailscale-serve-8443-publish-controller-restart-handler'

export const ASK_TWO: AskRequest = {
  id: 'ask-two',
  question: 'Push the branch to origin?',
  detail: null,
  options: ['Push', 'Not yet'],
  source: '/Users/someone/Development/orbit',
  sessionId: 's1',
}

export const ASK_FOUR: AskRequest = {
  id: 'ask-four',
  question: 'The build failed on the second attempt. How would you like to proceed?',
  detail: null,
  options: [
    'Retry with a clean node_modules',
    'Skip the failing package and keep going',
    'Stop here and leave the tree as it is',
    'Show me the full log before deciding',
  ],
  source: '/Users/someone/Development/orbit/web',
  sessionId: 's1',
}

export const ASK_LONG: AskRequest = {
  id: 'ask-long',
  question: LONG_QUESTION,
  detail: `pnpm --filter ${UNBREAKABLE} run migrate --force --no-verify`,
  options: ['Go ahead', 'Wait'],
  source: '/Users/someone/Development/orbit/server/src/store.ts',
  sessionId: 's1',
}

export const ASK_NO_SOURCE: AskRequest = {
  id: 'ask-bare',
  question: 'Ready?',
  detail: null,
  options: [],
  source: null,
  sessionId: null,
}

export const APPROVAL_SHORT: ApprovalRequest = {
  id: 'ap-1',
  label: 'Claude wants to run a command that deletes files',
  command: 'rm -rf ./dist',
}

export const APPROVAL_LONG: ApprovalRequest = {
  id: 'ap-2',
  label:
    'Claude wants to run a command that rewrites git history on a branch that has already been pushed, which cannot be undone from here',
  command: `git filter-branch --index-filter 'git rm -r --cached --ignore-unmatch ${UNBREAKABLE}/secrets.env' --prune-empty -- --all`,
}
