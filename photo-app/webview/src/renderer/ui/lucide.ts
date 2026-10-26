import type { IconNode } from 'lucide';

type IconAttributes = Record<string, string | number | boolean | undefined>;

function serializeAttributes(attributes: IconAttributes): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(' ');
}

export function renderLucideIcon(
  name: string,
  iconNode: IconNode,
  attributes: IconAttributes = {}
): string {
  const svgAttributes = serializeAttributes({
    xmlns: 'http://www.w3.org/2000/svg',
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `lucide lucide-${name}`,
    ...attributes,
  });

  const children = iconNode
    .map(([tag, childAttributes]) => `<${tag} ${serializeAttributes(childAttributes)}></${tag}>`)
    .join('');

  return `<svg ${svgAttributes}>${children}</svg>`;
}
