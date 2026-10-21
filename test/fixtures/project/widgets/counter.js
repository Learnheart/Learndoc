// Fixture widget: a button that counts clicks. No DOM access at import time.
export default {
  name: 'counter',
  propsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['start'],
    properties: {
      start: { type: 'integer', minimum: 0 },
      label: { type: 'string', maxLength: 20 },
    },
  },
  mount(el, props) {
    const button = document.createElement('button');
    button.type = 'button';
    let count = props.start;
    let label = props.label ?? 'Clicks';
    const draw = () => { button.textContent = `${label}: ${count}`; };
    const onClick = () => { count += 1; draw(); };
    button.addEventListener('click', onClick);
    el.append(button);
    draw();
    return {
      update(next) { count = next.start; label = next.label ?? 'Clicks'; draw(); },
      destroy() { button.removeEventListener('click', onClick); button.remove(); },
    };
  },
};
