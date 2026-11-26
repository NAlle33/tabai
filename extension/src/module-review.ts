import type { ModuleReview } from '../../shared/personal-modules';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

const statusLabels = {
  confirmed: 'Bekräftat',
  missing: 'Saknas / behöver bekräftas',
  conflict: 'Motstridiga uppgifter',
};

function sourceLink(label: string, url?: string): HTMLElement {
  try {
    const parsedUrl = new URL(url ?? '');
    if (['http:', 'https:'].includes(parsedUrl.protocol) && !parsedUrl.username && !parsedUrl.password) {
      const link = node('a', label);
      link.href = parsedUrl.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }
  } catch {
    // A source without a safe URL remains available as a plain label.
  }
  return node('span', label);
}

export function renderModuleReview(review: ModuleReview, correct?: (field: string, value: string) => Promise<void>): HTMLElement {
  const card = node('section', '', 'module-review');
  card.setAttribute('aria-label', review.title);
  card.append(node('h3', review.title), node('p', review.summary, 'muted'));

  const verification = node('div', '', `review-verification review-${review.verification.state}`);
  verification.dataset.verification = review.verification.state;
  verification.append(node('p', review.verification.message));
  if (review.verification.checkedAt) {
    const time = node('time', `Kontrollerat ${new Date(review.verification.checkedAt).toLocaleString('sv-SE')}`, 'muted');
    time.dateTime = review.verification.checkedAt;
    verification.append(time);
  }
  if (review.verification.issues.length) {
    const list = node('ul');
    for (const issue of review.verification.issues) list.append(node('li', issue));
    verification.append(list);
  }
  card.append(verification);

  if (review.overview) {
    const overview = node('dl', '', 'review-overview');
    for (const item of review.overview) {
      const entry = node('div'); entry.append(node('dt', item.label), node('dd', item.value));
      if (item.note) entry.append(node('dd', item.note, 'muted')); overview.append(entry);
    }
    card.append(overview);
  }
  const unresolved = review.sections.flatMap(section => section.items.filter(item => item.status !== 'confirmed').map(item => `${section.title}: ${item.label} — ${statusLabels[item.status]}`));
  if (unresolved.length) {
    const attention = node('div', '', 'review-attention'); attention.append(node('h4', 'Behöver din uppmärksamhet'));
    const list = node('ul'); for (const issue of unresolved) list.append(node('li', issue)); attention.append(list); card.append(attention);
  }
  const details = node('details'); details.dataset.keep = 'review'; details.append(node('summary', 'Alla uppgifter och källor'));
  // Legacy modules retain their existing expanded presentation.
  const sectionsRoot = review.overview ? details : card;
  if (review.overview) card.append(details);

  for (const section of review.sections) {
    const group = node('section', '', 'review-section');
    const fields = node('dl');
    group.append(node('h4', section.title), fields);

    for (const field of section.items) {
      const entry = node('div', '', 'review-field');
      entry.dataset.status = field.status;
      const label = node('dt', field.label);
      const value = node('dd');
      value.append(
        node('span', field.value, 'review-value'),
        node('span', statusLabels[field.status], `review-status review-${field.status}`),
      );
      if (field.note) value.append(node('p', field.note, 'muted'));
      if (correct && field.id) {
        const editor = node('details'); editor.dataset.keep = `edit-${field.id}`; editor.append(node('summary', `Ändra ${field.label.toLocaleLowerCase('sv-SE')}`));
        const form = node('form'), label = node('label', field.label), input = node('input');
        input.defaultValue = field.editValue ?? field.value; input.dataset.field = field.id; input.required = true; input.maxLength = 300;
        label.append(input); const save = node('button', 'Spara ändringen'); save.type = 'submit';
        const note = node('p', 'Sparar din uppgift. Fortsätt sedan ärendet för att uppdatera och kontrollera resultatet.', 'muted');
        form.append(label, save, note); form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void correct(field.id!, input.value); };
        editor.append(form); value.append(editor);
      }

      if (field.sources.length) {
        const sources = node('details');
        sources.append(node('summary', `Källor (${field.sources.length})`));
        for (const source of field.sources) {
          const item = node('div', '', 'review-source');
          item.append(sourceLink(source.label, source.url), node('blockquote', source.quote));
          sources.append(item);
        }
        value.append(sources);
      }
      entry.append(label, value);
      fields.append(entry);
    }
    sectionsRoot.append(group);
  }
  return card;
}
