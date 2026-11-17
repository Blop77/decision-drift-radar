import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Em,
  EmptyState,
  Heading,
  Inline,
  Label,
  Link,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  useProductContext,
  xcss
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { CandidateCard, draftPayload, driftStatus, KIND_GROUPS, notePayload, siteLink, withNote } from './candidate-card';

const tileStyle = xcss({ backgroundColor: 'color.background.neutral', borderRadius: 'border.radius.200', padding: 'space.150', minWidth: '120px' });
const alertTileStyle = xcss({ backgroundColor: 'color.background.danger', borderRadius: 'border.radius.200', padding: 'space.150', minWidth: '120px' });
const panelStyle = xcss({ paddingTop: 'space.200' });

/** One headline number. */
function Tile({ value, label, alert = false }) {
  return (
    <Box xcss={alert ? alertTileStyle : tileStyle}>
      <Stack space="space.025">
        <Heading size="large">{String(value)}</Heading>
        <Text>{label}</Text>
      </Stack>
    </Box>
  );
}

/** The radar at a glance: what needs attention first. */
function Summary({ radar, previousVisitAt }) {
  return (
    <Stack space="space.100">
      <Inline space="space.150" shouldWrap>
        <Tile value={radar.drifting} label={radar.drifting === 1 ? 'open drift' : 'open drifts'} alert={radar.drifting > 0} />
        {previousVisitAt && <Tile value={radar.newDrifts + radar.newSinceLastVisit} label="new since last visit" />}
        <Tile value={radar.findings} label={radar.findings === 1 ? 'finding' : 'findings'} />
        <Tile value={radar.resolved} label="resolved" />
      </Inline>
      <Text>
        <Em>
          A drift is a decision and an issue that still uses the wording the decision replaced. Radar finds them on each scan
          and as soon as an issue is created or edited.{previousVisitAt ? ` Last visit: ${new Date(previousVisitAt).toLocaleDateString()}.` : ' New findings are counted from your next visit.'}
        </Em>
      </Text>
    </Stack>
  );
}

/** Drifting findings first, then the rest in scan order. */
const driftingFirst = (list) => [...list].sort((a, b) => Number(Boolean(driftStatus(b)?.open)) - Number(Boolean(driftStatus(a)?.open)));

function DriftNotificationSetting({ projectKey }) {
  const [setting, setSetting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    invoke('getDriftNotificationSetting', { projectKey })
      .then((stored) => { if (active) setSetting(stored); })
      .catch(() => { if (active) setSetting({ ok: false }); });
    return () => { active = false; };
  }, [projectKey]);

  if (!setting) return null;
  if (!setting.ok) return <Text>Could not load drift notification settings. Refresh to try again.</Text>;
  if (!setting.canManage) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke('setDriftNotificationSetting', { projectKey, enabled: !setting.enabled });
      if (updated.ok) setSetting({ ...setting, enabled: updated.enabled });
      else setError(updated.error);
    } catch {
      setError('Could not save the drift notification setting. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack space="space.100">
      <Heading size="small">Notify assignee and reporter when new drift is found</Heading>
      <Text>
        Off by default. When enabled, Jira emails the issue’s assignee and reporter when an issue creation or edit
        first reveals a drift. The notification uses fixed text and sends no decision details. Recipients may receive
        the notice even when they cannot read the decision source. Radar checks their access when they open the issue panel.
      </Text>
      <Inline space="space.100" alignBlock="center">
        <Text>{setting.enabled ? 'Notifications are on' : 'Notifications are off'}</Text>
        <Button onClick={save} isDisabled={saving}>
          {saving ? 'Saving…' : setting.enabled ? 'Turn off notifications' : 'Turn on notifications'}
        </Button>
      </Inline>
      {error && <SectionMessage appearance="error" title="Notification setting not saved">{error}</SectionMessage>}
    </Stack>
  );
}

/** Confluence pages added to the project by link, so a decision page needn't mention the project key. */
function LinkedPages({ projectKey, siteUrl, onChanged }) {
  const [state, setState] = useState(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    try {
      setState(await invoke('getLinkedPages', { projectKey }));
    } catch {
      setState({ ok: false });
    }
  };
  useEffect(() => { load(); }, [projectKey]);

  if (!state?.ok) return null;
  const run = async (action, payload, success) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await invoke(action, { projectKey, ...payload });
      if (!response?.ok) {
        setMessage({ appearance: 'error', text: response?.error ?? 'Something went wrong. Try again.' });
        return;
      }
      if (success) setMessage({ appearance: 'success', text: success(response) });
      setLink('');
      await load();
      onChanged?.();
    } catch {
      setMessage({ appearance: 'error', text: 'Something went wrong. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack space="space.100">
      <Heading size="small">Confluence pages added by link</Heading>
      <Text>
        Scans include these pages even if they never mention {projectKey}. Up to 10 pages; each person sees only pages
        they can open. A page created in the last few minutes may not be findable until Confluence has indexed it.
      </Text>
      {state.pages.map((page) => {
        const href = siteLink(siteUrl, page.url);
        return (
          <Inline key={page.id} space="space.100" alignBlock="center">
            <Text>{href ? <Link href={href}>{page.title}</Link> : page.title}</Text>
            {state.canEdit && (
              <Button appearance="subtle" isDisabled={busy} onClick={() => run('removeLinkedPage', { pageId: page.id })}>Remove</Button>
            )}
          </Inline>
        );
      })}
      {state.hidden > 0 && <Text>{state.hidden === 1 ? '1 added page is' : `${state.hidden} added pages are`} not visible to you.</Text>}
      {state.canEdit && (
        <Inline space="space.100" alignBlock="end">
          <Stack space="space.050">
            <Label labelFor="linked-page">Confluence page link</Label>
            <Textfield
              id="linked-page"
              name="linkedPage"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://your-site.atlassian.net/wiki/spaces/…/pages/…"
            />
          </Stack>
          <Button isDisabled={busy || !link.trim()} onClick={() => run('addLinkedPage', { link }, (r) => `Added “${r.added.title}”. Scanning again to include it.`)}>
            {busy ? 'Saving…' : 'Add page'}
          </Button>
        </Inline>
      )}
      {message && <SectionMessage appearance={message.appearance}>{message.text}</SectionMessage>}
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  const siteUrl = context?.siteUrl;
  // Set when the app is opened from a Jira project's own page.
  const contextProjectKey = context?.extension?.project?.key;
  const [projectKey, setProjectKey] = useState('');
  const [projects, setProjects] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState(null);
  const [reviewError, setReviewError] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  const scan = async (key = projectKey) => {
    setLoading(true);
    setResult(null);
    setAiResult(null);
    setAiError(null);
    setReviewError(null);
    try {
      const response = await invoke('getProjectRadar', { projectKey: key });
      setResult(response);
      // Findings from an earlier AI pass, already checked again against this scan's sources.
      if (response?.ok && response.aiCandidates?.length > 0) {
        setAiResult({ ok: true, saved: true, savedAt: response.aiSavedAt, candidates: response.aiCandidates, rejected: 0 });
      }
    } catch {
      setResult({ ok: false, error: 'The project scan failed. Refresh the page and try again.' });
    } finally {
      setLoading(false);
    }
  };

  // Runs the same analysis on a small bundled project. Touches nothing on the site.
  const scanSample = async () => {
    setLoading(true);
    setResult(null);
    setAiResult(null);
    setAiError(null);
    setReviewError(null);
    try {
      setResult(await invoke('getSampleRadar'));
    } catch {
      setResult({ ok: false, error: 'The sample scan failed. Refresh the page and try again.' });
    } finally {
      setLoading(false);
    }
  };

  // Asks the AI for decisions the wording rules missed. Only on request: usage is billed per call.
  // For a real project the AI pass runs as a background job; this polls until it finishes.
  const findWithAi = async () => {
    if (!result?.ok) return;
    setAiLoading(true);
    setAiError(null);
    try {
      let response = result.sample
        ? await invoke('getSampleAiFindings')
        : await invoke('getAiFindings', { projectKey: result.projectKey });
      const deadline = Date.now() + 6 * 60 * 1000;
      while (response?.ok && response.pending && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        response = await invoke('getAiJob', { projectKey: result.projectKey });
      }
      if (response?.ok && response.pending) {
        setAiError('The AI pass is still running. Its findings will appear here when you scan again in a few minutes.');
      } else if (response?.ok) setAiResult(response);
      else setAiError(response?.error ?? 'The AI pass could not complete.');
    } catch {
      setAiError('The AI pass could not complete. The current findings are unaffected.');
    } finally {
      setAiLoading(false);
    }
  };

  const sampleButton = (
    <Button appearance="default" onClick={scanSample} isDisabled={loading || aiLoading}>
      Try with sample data
    </Button>
  );

  // On a project page, scan that project straight away.
  useEffect(() => {
    if (!contextProjectKey) return;
    setProjectKey(contextProjectKey);
    scan(contextProjectKey);
  }, [contextProjectKey]);

  // Elsewhere, offer the projects the user can see. If the list fails, a key can still be typed.
  useEffect(() => {
    if (!context || contextProjectKey) return undefined;
    let cancelled = false;
    invoke('listProjects')
      .then((response) => { if (!cancelled) setProjects(response?.ok ? response : { projects: [] }); })
      .catch(() => { if (!cancelled) setProjects({ projects: [] }); });
    return () => { cancelled = true; };
  }, [Boolean(context), contextProjectKey]);

  const projectOptions = (projects?.projects ?? []).map((project) => ({ label: `${project.name} (${project.key})`, value: project.key }));

  // The server builds the exact comment; a sample preview reads only the bundled sample.
  const previewNote = async (candidate, issueKey, note) => {
    try {
      return result?.sample
        ? await invoke('previewSampleNote', { candidateId: candidate.id, issueKey, note })
        : await invoke('previewDecisionNote', notePayload(candidate, issueKey, note));
    } catch {
      return { ok: false, error: 'Could not prepare the comment preview. Try again.' };
    }
  };

  const applyNote = async (candidate, issueKey, note, digest) => {
    try {
      const response = await invoke('applyDecisionNote', notePayload(candidate, issueKey, note, digest));
      if (response?.ok) {
        setResult((current) => withNote(current, candidate.id, issueKey, response.note));
        setAiResult((current) => current?.ok ? withNote(current, candidate.id, issueKey, response.note) : current);
      }
      return response;
    } catch {
      return { ok: false, error: `Could not add the note. Open ${issueKey} to check whether the comment was posted before trying again.` };
    }
  };

  const draftNote = async (candidate, issueKey) => {
    try {
      return await invoke('draftDecisionNote', draftPayload(candidate, issueKey));
    } catch {
      return { ok: false, error: 'The AI could not draft a note. You can still write it yourself.' };
    }
  };

  const issueUrls = Object.fromEntries((result?.issues ?? []).filter((i) => i.url).map((i) => [i.key, i.url]));

  // A finding can appear in the scan or in the AI pass; keep both lists in step.
  const updateCandidate = (id, change) => {
    const apply = (current) => current?.candidates
      ? { ...current, candidates: current.candidates.map((item) => (item.id === id ? change(item) : item)) }
      : current;
    setResult(apply);
    setAiResult(apply);
  };

  const reviewCandidate = async (candidate, choice) => {
    setReviewBusyId(candidate.id);
    setReviewError(null);
    try {
      const target = {
        projectKey: candidate.source.projectKey,
        candidateId: candidate.id,
        issueKey: candidate.affectedIssues[0]?.issueKey
      };
      const response = choice === 'reset'
        ? await invoke('clearDecisionReview', target)
        : await invoke('reviewDecision', { ...target, choice });
      if (!response?.ok) {
        setReviewError(response?.error ?? 'Could not save the review. Try again.');
        return;
      }
      updateCandidate(candidate.id, (item) => ({ ...item, review: response.review ?? null }));
    } catch {
      setReviewError('Could not save the review. Check your connection and try again.');
    } finally {
      setReviewBusyId(null);
    }
  };

  const cardProps = (candidate) => ({
    candidate,
    siteUrl,
    issueUrls,
    sample: Boolean(result?.sample),
    onReview: result?.sample ? undefined : (choice) => reviewCandidate(candidate, choice),
    reviewBusy: reviewBusyId === candidate.id,
    onApplyNote: result?.sample ? undefined : (issueKey, note, digest) => applyNote(candidate, issueKey, note, digest),
    onPreviewNote: (issueKey, note) => previewNote(candidate, issueKey, note),
    onDraftNote: result?.sample ? undefined : (issueKey) => draftNote(candidate, issueKey)
  });
  const findingCount = (result?.candidates?.length ?? 0) + (aiResult?.candidates?.length ?? 0);

  const findingsPanel = result?.ok && (
    <Stack space="space.300">
      {(result.candidates ?? []).length === 0 && !(aiResult?.candidates?.length > 0) ? (
        <EmptyState
          header={`No decisions found in ${result.projectKey} yet`}
          description={`Radar looks for explicit wording such as “Decision:”, “we agreed” or “we decided to” in ${result.projectKey}'s issues, comments and the Confluence pages that mention it. Add a decision like that to a page or an issue and scan again, add a decision page by link in Settings, or try the sample to see what a finding looks like.`}
          primaryAction={<Button appearance="primary" onClick={scanSample} isDisabled={loading || aiLoading}>Try with sample data</Button>}
          secondaryAction={result.sample ? undefined : <Button onClick={() => scan(result.projectKey)} isDisabled={loading || aiLoading}>Scan again</Button>}
        />
      ) : KIND_GROUPS.map(({ kind, title }) => {
        const group = driftingFirst(result.candidates.filter((candidate) => candidate.kind === kind));
        if (group.length === 0) return null;
        return (
          <Stack key={kind} space="space.200">
            <Heading size="medium">{title} · {group.length}</Heading>
            {group.map((candidate) => <CandidateCard key={candidate.id} {...cardProps(candidate)} />)}
          </Stack>
        );
      })}
      <Stack space="space.150">
        <Heading size="medium">Find more with AI</Heading>
        <Text>
          The findings above come from wording rules. The optional AI pass looks for decisions phrased indirectly and keeps
          only those quoted word for word from the source.{result.sample ? ' It reads nothing from your site.' : ''}
        </Text>
        <Inline>
          <Button appearance="default" onClick={findWithAi} isDisabled={aiLoading || loading}>
            {aiLoading ? 'Asking the AI…' : 'Find more with AI'}
          </Button>
        </Inline>
        {aiLoading && <Inline space="space.100"><Spinner /><Text>{result.sample ? 'Reading the sample pages and issues…' : 'The AI is reading your pages and issues in the background. This usually takes under a minute; you can leave this page and the findings will appear on your next scan.'}</Text></Inline>}
        {aiError && <SectionMessage appearance="warning" title="AI pass not run">{aiError}</SectionMessage>}
        {aiResult?.ok && !aiResult.saved && aiResult.candidates.length === 0 && (
          <SectionMessage appearance="information" title="Nothing more found">
            The AI found no further decisions with a quote it could match to the source.
          </SectionMessage>
        )}
        {aiResult?.ok && aiResult.candidates.length > 0 && (
          <Stack space="space.200">
            <Text>
              {aiResult.saved
                ? `${aiResult.candidates.length} ${aiResult.candidates.length === 1 ? 'finding' : 'findings'} from an earlier AI pass${aiResult.savedAt ? ` (${new Date(aiResult.savedAt).toLocaleDateString()})` : ''}, checked again word for word against the current sources. Teammates and the issue panel see them too.`
                : `${aiResult.candidates.length} AI ${aiResult.candidates.length === 1 ? 'finding' : 'findings'}${typeof aiResult.newCount === 'number' ? ` (${aiResult.newCount} new)` : ''}, each with a quote checked against its source.${aiResult.rejected > 0 ? ` ${aiResult.rejected} AI ${aiResult.rejected === 1 ? 'suggestion was' : 'suggestions were'} left out because ${aiResult.rejected === 1 ? 'it' : 'they'} did not pass the app's quote checks.` : ''}`}
            </Text>
            {driftingFirst(aiResult.candidates).map((candidate) => <CandidateCard key={candidate.id} {...cardProps(candidate)} />)}
          </Stack>
        )}
      </Stack>
    </Stack>
  );

  const sourcesPanel = result?.ok && (
    <Stack space="space.200">
      {result.graph?.used && result.graph.teams.length > 0 && (
        <SectionMessage appearance="discovery" title={result.sample ? 'Context from Teamwork Graph (sample)' : 'Context from Teamwork Graph'}>
          Teams linked to {result.projectKey}: {result.graph.teams.join(', ')}.
          {result.graph.spaces.length > 0 ? ` Their Confluence spaces: ${result.graph.spaces.join(', ')}.` : ''}
          {` Added ${result.graph.pagesAdded} decision ${result.graph.pagesAdded === 1 ? 'page' : 'pages'} from those spaces and ${result.graph.linkedPagesAdded} linked ${result.graph.linkedPagesAdded === 1 ? 'page' : 'pages'} that do not mention ${result.projectKey}.`}
        </SectionMessage>
      )}
      {result.graph?.note && !result.sample && <Text><Em>{result.graph.note}</Em></Text>}
      {result.warnings?.length > 0 ? (
        <SectionMessage appearance="warning" title="Confluence project-key search unavailable">
          {result.warnings.join(' ')} Jira descriptions and comments were still scanned.
        </SectionMessage>
      ) : result.pages?.length > 0 ? (
        <Stack space="space.100">
          <Heading size="medium">{result.sample ? 'Sample Confluence pages' : `Confluence pages scanned for ${result.projectKey}`}</Heading>
          {result.pages.map((source) => {
            const href = siteLink(siteUrl, source.url);
            return (
              <Text key={source.id}>
                {href ? <Link href={href}>{source.title}</Link> : source.title}
                {source.via ? ` · found through ${source.via}` : ''}
              </Text>
            );
          })}
        </Stack>
      ) : (
        <SectionMessage appearance="information" title="No matching Confluence pages found">
          The scan looks for pages that mention {result.projectKey ?? 'the project key'}. A page created in the last few
          minutes may not be searchable yet, so scan again shortly. A decision page that doesn't mention the key can be
          added by link in Settings.
        </SectionMessage>
      )}
      {result.issues.length > 0 && (
        <Stack space="space.100">
          <Heading size="medium">{result.sample ? 'Sample issues scanned' : `Recent ${result.projectKey} issues scanned`} · {result.issues.length}</Heading>
          {result.issues.map((issue) => (
            <Text key={issue.key}>
              {siteLink(siteUrl, issue.url) ? <Link href={siteLink(siteUrl, issue.url)}>{issue.key}</Link> : issue.key}
              {` · ${issue.status} · ${issue.summary}`}
              {issue.labels.length > 0 ? ` · Labels: ${issue.labels.join(', ')}` : ''}
            </Text>
          ))}
        </Stack>
      )}
      <SectionMessage appearance="information" title="How matching works">
        Each finding quotes its source and lists the signals behind it: decision wording, issue keys named in the
        quote or its paragraph, shared terms, and issues that still mention what a decision replaces. Signals are
        heuristics, not certainty. Mark a finding relevant or dismiss it to save the team's review for this project.
        A review alone never changes Jira; a relevant finding can then be posted as a comment you edit and confirm.
      </SectionMessage>
    </Stack>
  );

  return (
    <Stack space="space.300">
      <Text>
        Find decisions that may not have made it into the work they affect. Every finding quotes its source, and nothing
        is posted to Jira without your confirmation.
      </Text>

      {contextProjectKey ? (
        <Inline space="space.150" alignBlock="center">
          <Text>Project {contextProjectKey}</Text>
          <Button appearance="default" onClick={() => scan(contextProjectKey)} isDisabled={loading || aiLoading}>
            {loading ? 'Scanning…' : 'Scan again'}
          </Button>
          {sampleButton}
        </Inline>
      ) : (
        <Inline space="space.150" alignBlock="end">
          {projectOptions.length > 0 ? (
            <Stack space="space.050">
              <Label labelFor="project-select">Jira project</Label>
              <Select
                inputId="project-select"
                options={projectOptions}
                value={projectOptions.find((option) => option.value === projectKey) ?? null}
                onChange={(option) => setProjectKey(option?.value ?? '')}
                placeholder="Choose a project"
              />
              {projects?.more && <Text>Showing the first 50 projects.</Text>}
            </Stack>
          ) : (
            <Stack space="space.050">
              <Label labelFor="project-key">Jira project key</Label>
              <Textfield
                id="project-key"
                name="projectKey"
                value={projectKey}
                onChange={(event) => setProjectKey(event.target.value)}
                placeholder={projects ? 'For example, MC' : 'Loading projects…'}
              />
            </Stack>
          )}
          <Button appearance="primary" onClick={() => scan()} isDisabled={loading || aiLoading || !projectKey.trim()}>
            {loading ? 'Scanning…' : 'Scan project'}
          </Button>
          {sampleButton}
        </Inline>
      )}

      {loading && <Inline space="space.100"><Spinner /><Text>Scanning…</Text></Inline>}
      {result && !result.ok && <SectionMessage appearance="error" title="Could not scan project">{result.error}</SectionMessage>}
      {reviewError && <SectionMessage appearance="error" title="Review not saved">{reviewError}</SectionMessage>}

      {result?.ok && (
        <Stack space="space.200">
          {result.sample && (
            <SectionMessage appearance="discovery" title="Sample data: a fictional payments team">
              A small project bundled with the app, so you can see a full result before you have any data. Nothing was read
              from or written to your site. Choose a project to scan your own work.
            </SectionMessage>
          )}
          {result.radar && <Summary radar={result.radar} previousVisitAt={result.previousVisitAt} />}
          <Text>
            Scanned {result.issues.length} {result.sample ? 'sample' : `recent ${result.projectKey}`} issues and {result.pages?.length ?? 0}
            {result.sample ? ' sample' : ''} Confluence{result.pages?.length === 1 ? ' page' : ' pages'}.
            {(result.coverage?.moreIssues || result.coverage?.morePages) ? ' Partial coverage: ' : ''}
            {result.coverage?.moreIssues ? `only the ${result.issues.length} most recently updated issues were checked. ` : ''}
            {result.coverage?.morePages ? `More pages mention ${result.projectKey} than the ${result.coverage.pageLimit} most recently edited that a scan reads. ` : ''}
          </Text>
          {result.radarWarning && <SectionMessage appearance="warning" title="Drift history unavailable">{result.radarWarning}</SectionMessage>}
          {result.issues.length === 0 && (
            <SectionMessage appearance="warning" title={`No issues found in ${result.projectKey}`}>
              Check the project key, or pick a project with issues. Findings can still come from Confluence pages, but no
              issue can be matched to them.
            </SectionMessage>
          )}
          {result.notice && <SectionMessage appearance="information">{result.notice}</SectionMessage>}
          {result.reviewWarning && <SectionMessage appearance="warning" title="Review history unavailable">{result.reviewWarning}</SectionMessage>}
          {result.sample ? (
            <Tabs id="radar-sample-tabs">
              <TabList>
                <Tab>{`Findings · ${findingCount}`}</Tab>
                <Tab>Sources</Tab>
              </TabList>
              <TabPanel><Box xcss={panelStyle}>{findingsPanel}</Box></TabPanel>
              <TabPanel><Box xcss={panelStyle}>{sourcesPanel}</Box></TabPanel>
            </Tabs>
          ) : (
            <Tabs id="radar-tabs">
              <TabList>
                <Tab>{`Findings · ${findingCount}`}</Tab>
                <Tab>Sources</Tab>
                <Tab>Settings</Tab>
              </TabList>
              <TabPanel><Box xcss={panelStyle}>{findingsPanel}</Box></TabPanel>
              <TabPanel><Box xcss={panelStyle}>{sourcesPanel}</Box></TabPanel>
              <TabPanel>
                <Box xcss={panelStyle}>
                  <Stack space="space.400">
                    <LinkedPages projectKey={result.projectKey} siteUrl={siteUrl} onChanged={() => scan(result.projectKey)} />
                    <DriftNotificationSetting projectKey={result.projectKey} />
                  </Stack>
                </Box>
              </TabPanel>
            </Tabs>
          )}
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
