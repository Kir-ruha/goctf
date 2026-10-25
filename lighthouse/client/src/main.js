import { createApp, ref } from 'vue/dist/vue.esm-bundler.js';
import { decrypt } from './crypto.js';
import './style.css';

const textBytes = new TextEncoder();

createApp({
  setup() {
    const queue = ref(''), key = ref(''), pass = ref(''), recipient = ref('');
    const queueLabel = ref('untitled'), retention = ref(3600);
    const topic = ref('inbox'), delay = ref(0), text = ref('');
    const source = ref('int filter(int length) {\n  return length <= 4096;\n}');
    const filterLabel = ref('unnamed'), revision = ref('');
    const selectedFilter = ref(null);
    const received = ref([]), filters = ref([]);
    const state = ref(null), view = ref('messages'), showRead = ref(false);
    const feedback = ref({}), compiler = ref(''), listing = ref('');
    const path = suffix => '/api/queues/' + queue.value + suffix;
    const credentials = () => queue.value + ':' + key.value;

    async function api(url, options = {}, accepted = []) {
      const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }
      });
      const body = await response.json();
      if (!response.ok && !accepted.includes(response.status)) throw Error(body.error || body.compiler || 'Request failed');
      return body;
    }

    async function action(name, work) {
      feedback.value[name] = null;
      try {
        const result = await work();
        feedback.value[name] = typeof result === 'string' ? { kind: 'ok', text: result } : result;
      }
      catch (problem) { feedback.value[name] = { kind: 'error', text: problem.message }; }
    }

    async function refresh() {
      state.value = await api(path(''));
    }
    const headers = () => ({ 'X-Queue-Key': key.value });

    const create = () => action('access', async () => {
      const created = await api('/api/queues', {
        method: 'POST', body: JSON.stringify({ label: queueLabel.value, retention_seconds: Number(retention.value) })
      });
      queue.value = created.id;
      key.value = created.read_key;
      pass.value = credentials();
      state.value = created;
      recipient.value = created.id;
      received.value = [];
      filters.value = [];
      selectedFilter.value = null;
      view.value = 'messages';
      return 'Mailbox created. Save your access pass.';
    });
    const open = () => action('open', async () => {
      const [id, secret, extra] = pass.value.trim().split(':');
      if (!id || !secret || extra) throw Error('Enter a mailbox access pass in the form UUID:read_key.');
      const info = await api('/api/queues/' + id);
      await api('/api/queues/' + id + '/messages?show_read=true', { headers: { 'X-Queue-Key': secret } });
      queue.value = id;
      key.value = secret;
      state.value = info;
      recipient.value = id;
      received.value = [];
      filters.value = [];
      selectedFilter.value = null;
      view.value = 'messages';
      feedback.value.access = { kind: 'ok', text: 'Mailbox opened.' };
    });
    const leave = () => {
      queue.value = '';
      key.value = '';
      pass.value = '';
      state.value = null;
      received.value = [];
      filters.value = [];
      selectedFilter.value = null;
      compiler.value = '';
      listing.value = '';
      feedback.value = {};
      feedback.value.open = { kind: 'ok', text: 'Mailbox closed.' };
    };
    const send = () => action('send', async () => {
      const id = recipient.value.trim();
      if (!text.value) throw Error('Write a message first.');
      const raw = textBytes.encode(text.value);
      if (raw.length > 4096) throw Error('Messages must be at most 4096 bytes.');
      await api('/api/queues/' + id + '/messages', {
        method: 'POST',
        body: JSON.stringify({
          message: btoa(Array.from(raw, byte => String.fromCharCode(byte)).join('')),
          topic: topic.value,
          delay_ms: Number(delay.value)
        })
      });
      text.value = '';
      if (state.value) await refresh();
      return 'Message sent.';
    });
    const receive = () => action('receive', async () => {
      await refresh();
      const result = await api(path('/messages' + (showRead.value ? '?show_read=true' : '')), { headers: headers() });
      received.value = result.messages.map(message => {
        try {
          return { id: message.id, topic: message.topic, text: decrypt(key.value, message.ciphertext) };
        } catch {
          return { id: message.id, topic: message.topic, text: 'Cannot open this message.' };
        }
      });
      await refresh();
      return result.messages.length ? result.messages.length + ' message(s) displayed.' : 'No messages to display.';
    });
    const loadFilters = () => action('refreshFilters', async () => {
      filters.value = (await api(path('/filters'))).filters;
      return 'Revision list updated.';
    });
    const selectFilter = filter => action('selectFilter', async () => {
      const details = await api(path('/filters/' + filter.revision), { headers: headers() });
      revision.value = details.revision;
      selectedFilter.value = details;
      return 'Revision #' + details.revision + ' selected.';
    });
    const newDraft = () => {
      selectedFilter.value = null;
      revision.value = '';
      compiler.value = '';
      listing.value = '';
      feedback.value.compile = null;
      feedback.value.selectFilter = { kind: 'ok', text: 'Draft editor ready.' };
    };
    const install = () => action('compile', async () => {
      compiler.value = '';
      listing.value = '';
      const result = await api(path('/filter'), {
        method: 'POST', body: JSON.stringify({ source: source.value, label: filterLabel.value })
      }, [422]);
      compiler.value = result.compiler || '';
      listing.value = result.listing || '';
      filters.value = (await api(path('/filters'))).filters;
      if (!result.ok) {
        return { kind: 'error', text: 'Revision #' + result.revision + ' rejected. See compiler output below.' };
      }
      return 'Revision #' + result.revision + ' ready. Select it to activate.';
    });
    const draftFrom = () => {
      if (!selectedFilter.value?.source) return;
      source.value = selectedFilter.value.source;
      filterLabel.value = selectedFilter.value.label;
      newDraft();
    };
    const activate = () => action('activate', async () => {
      await api(path('/filters/' + revision.value + '/activate'), {
        method: 'POST', headers: headers()
      });
      filters.value = (await api(path('/filters'))).filters;
      if (selectedFilter.value) selectedFilter.value.active = true;
      await refresh();
      return 'Revision #' + revision.value + ' activated.';
    });

    return {
      queue, pass, recipient, queueLabel, retention, topic, delay, text,
      source, filterLabel, revision, selectedFilter, received, filters, state, view, showRead,
      feedback, compiler, listing, credentials,
      create, open, leave, send, receive, loadFilters, selectFilter, newDraft, draftFrom, install, activate
    };
  },
  template: `
    <main>
      <header class="masthead">
        <div class="brand-mark">✦</div>
        <div><p class="eyebrow">LIGHTHOUSE / MAIL</p><h1>Lighthouse</h1><p>A quiet place for messages with a programmable door.</p></div>
      </header>
      <div v-if="!state" class="entry-grid">
        <section class="panel">
          <p class="eyebrow">NEW MAILBOX</p><h2>Create a mailbox</h2>
          <p class="muted">We generate the address and private access key for you.</p>
          <label>Mailbox name<input v-model="queueLabel" maxlength="48" autocomplete="off"></label>
          <label>Keep messages for (seconds)<input v-model.number="retention" type="number" min="60" max="604800"></label>
          <div class="actions"><button @click="create">Create mailbox</button><span v-if="feedback.access" class="action-feedback" :class="feedback.access.kind" :role="feedback.access.kind === 'error' ? 'alert' : 'status'">{{ feedback.access.text }}</span></div>
        </section>
        <section class="panel">
          <p class="eyebrow">RETURNING</p><h2>Open your mailbox</h2>
          <p class="muted">Use the access pass you received when you created it.</p>
          <label>Access pass<input v-model="pass" placeholder="UUID:read_key" spellcheck="false" autocomplete="off" @keyup.enter="open"></label>
          <div class="actions"><button class="secondary" @click="open">Open mailbox</button><span v-if="feedback.open" class="action-feedback" :class="feedback.open.kind" :role="feedback.open.kind === 'error' ? 'alert' : 'status'">{{ feedback.open.text }}</span></div>
        </section>
        <section class="panel send-panel">
          <p class="eyebrow">PUBLIC DELIVERY</p><h2>Send a message</h2>
          <p class="muted">No access pass needed. All you need is the recipient's mailbox address.</p>
          <label>Mailbox address<input v-model="recipient" spellcheck="false" placeholder="Recipient UUID"></label>
          <div class="fields twin"><label>Topic<input v-model="topic"></label><label>Delay · ms<input v-model.number="delay" type="number" min="0" max="60000"></label></div>
          <label>Message<textarea v-model="text" placeholder="Write a message..."></textarea></label>
          <div class="actions"><button @click="send">Send message</button><span v-if="feedback.send" class="action-feedback" :class="feedback.send.kind" :role="feedback.send.kind === 'error' ? 'alert' : 'status'">{{ feedback.send.text }}</span></div>
        </section>
      </div>

      <template v-else>
        <section class="panel identity-bar">
          <div><p class="eyebrow">YOUR MAILBOX</p><h2>{{ state.label }}</h2><p class="mono">{{ queue }}</p></div>
          <div class="identity-actions"><span>{{ state.ready_count ?? 0 }} unread / {{ state.stored_count ?? 0 }} stored</span><button class="secondary" @click="leave">Close mailbox</button></div>
          <details class="access"><summary>Access pass · keep private</summary><code>{{ credentials() }}</code></details>
          <span v-if="feedback.access" class="action-feedback" :class="feedback.access.kind" :role="feedback.access.kind === 'error' ? 'alert' : 'status'">{{ feedback.access.text }}</span>
        </section>
        <nav class="tabs" aria-label="Mailbox pages">
          <button :class="{ current: view === 'messages' }" @click="view = 'messages'">Messages</button>
          <button :class="{ current: view === 'filters' }" @click="view = 'filters'; loadFilters()">Door filters</button>
        </nav>

        <div v-if="view === 'messages'" class="entry-grid">
          <section class="panel">
            <p class="eyebrow">INBOX</p><h2>Messages</h2>
            <p class="muted">Reading collects new messages. They remain available in history until they expire.</p>
            <div class="actions"><button @click="receive">Read new messages</button><span v-if="feedback.receive" class="action-feedback" :class="feedback.receive.kind" :role="feedback.receive.kind === 'error' ? 'alert' : 'status'">{{ feedback.receive.text }}</span><details class="read-options"><summary>Options</summary><label><input type="checkbox" v-model="showRead"> Include already read</label></details></div>
            <div class="inbox" v-if="received.length"><article v-for="message in received" :key="message.id"><small>#{{ message.id }} · {{ message.topic }}</small><p>{{ message.text }}</p></article></div>
            <p v-else class="muted empty">No messages displayed.</p>
          </section>
          <section class="panel">
            <p class="eyebrow">OUTBOX</p><h2>Send a message</h2>
            <p class="muted">Anyone with a mailbox address can send. The service seals the message for its reader.</p>
            <label>To · public mailbox address<input v-model="recipient" spellcheck="false"></label>
            <div class="fields twin"><label>Topic<input v-model="topic"></label><label>Delay · ms<input v-model.number="delay" type="number" min="0" max="60000"></label></div>
            <label>Message<textarea v-model="text" placeholder="Write a message..."></textarea></label>
            <div class="actions"><button @click="send">Send message</button><span v-if="feedback.send" class="action-feedback" :class="feedback.send.kind" :role="feedback.send.kind === 'error' ? 'alert' : 'status'">{{ feedback.send.text }}</span></div>
          </section>
        </div>

        <div v-else class="entry-grid filters-grid">
          <section class="panel">
            <template v-if="selectedFilter">
              <p class="eyebrow">REVISION #{{ selectedFilter.revision }}</p><h2>{{ selectedFilter.label }}</h2>
              <p class="muted">{{ selectedFilter.state }}{{ selectedFilter.active ? ' · active' : '' }} · {{ selectedFilter.created_at }}</p>
              <label>C source<textarea class="source" :value="selectedFilter.source" readonly placeholder="Source not saved for this revision"></textarea></label>
              <pre v-if="selectedFilter.compiler">{{ selectedFilter.compiler }}</pre>
              <details v-if="selectedFilter.listing"><summary>Instruction listing</summary><pre>{{ selectedFilter.listing }}</pre></details>
              <div class="actions"><button class="secondary" @click="newDraft">Compile new draft</button><button v-if="selectedFilter.source" class="secondary" @click="draftFrom">Use source as draft</button></div>
            </template>
            <template v-else>
              <p class="eyebrow">FILTER EDITOR</p><h2>Compile new draft</h2>
              <p class="muted">A C function decides which messages enter. Compile a draft before activating it.</p>
              <label>Draft name<input v-model="filterLabel" maxlength="48"></label>
              <label>C source<textarea class="source" v-model="source" spellcheck="false"></textarea></label>
              <div class="actions"><button @click="install">Compile draft</button><span v-if="feedback.compile" class="action-feedback" :class="feedback.compile.kind" :role="feedback.compile.kind === 'error' ? 'alert' : 'status'">{{ feedback.compile.text }}</span></div>
              <pre v-if="compiler" class="diagnostic">{{ compiler }}</pre>
              <details v-if="listing"><summary>Instruction listing</summary><pre>{{ listing }}</pre></details>
            </template>
          </section>
          <section class="panel">
            <p class="eyebrow">FILTER HISTORY</p><h2>Revisions</h2>
            <p class="muted">Only one revision is active. Select a ready draft to make it the front door.</p>
            <div class="actions"><button class="secondary" @click="loadFilters">Refresh</button><span v-if="feedback.refreshFilters" class="action-feedback" :class="feedback.refreshFilters.kind" :role="feedback.refreshFilters.kind === 'error' ? 'alert' : 'status'">{{ feedback.refreshFilters.text }}</span></div>
            <div class="actions"><button :disabled="!selectedFilter || selectedFilter.state !== 'ready' || selectedFilter.active" @click="activate">Activate selected</button><span v-if="feedback.activate" class="action-feedback" :class="feedback.activate.kind" :role="feedback.activate.kind === 'error' ? 'alert' : 'status'">{{ feedback.activate.text }}</span></div>
            <span v-if="feedback.selectFilter" class="action-feedback" :class="feedback.selectFilter.kind" :role="feedback.selectFilter.kind === 'error' ? 'alert' : 'status'">{{ feedback.selectFilter.text }}</span>
            <ul class="history"><li v-for="filter in filters" :key="filter.revision"><button class="revision" :class="{ selected: selectedFilter?.revision === filter.revision }" @click="selectFilter(filter)"><span>#{{ filter.revision }} · {{ filter.label }}</span><span>{{ filter.active ? 'active' : filter.state }}</span></button></li></ul>
            <p v-if="!filters.length" class="muted empty">No revisions yet.</p>
          </section>
        </div>
      </template>
      <footer>LIGHTHOUSE / EVERY MESSAGE FINDS ITS SHORE</footer>
    </main>
  `
}).mount('#app');
