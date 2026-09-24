/** XML formatting and the tokenizer's well-formedness check (DOMParser is not in Node). */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { checkXml, decodeEntities, encodeEntities, formatXml, minifyXml, validateXml } from './xml.ts';

const SRC = '<?xml version="1.0"?><!-- top --><root a="1 > 0"><item id="1">text</item><empty/><group><x/><![CDATA[<raw>]]></group></root>';

describe('formatXml', () => {
  it('indents, keeping text-only elements on one line and everything else as written', () => {
    expect(formatXml(SRC)).toBe(
      [
        '<?xml version="1.0"?>',
        '<!-- top -->',
        '<root a="1 > 0">',
        '  <item id="1">text</item>',
        '  <empty/>',
        '  <group>',
        '    <x/>',
        '    <![CDATA[<raw>]]>',
        '  </group>',
        '</root>',
        '',
      ].join('\n'),
    );
  });

  it('minifies back to the original', () => {
    expect(minifyXml(formatXml(SRC))).toBe(SRC);
  });
});

describe('checkXml', () => {
  it('accepts well-formed XML', () => {
    expect(checkXml(SRC)).toBeNull();
    expect(validateXml(SRC)).toBeNull();
  });

  it('reports mismatched, unclosed and stray tags with their line', () => {
    expect(checkXml('<a>\n<b>\n</a>')!.line).toBe(3);
    expect(checkXml('<a>\n<b>\n</a>')!.message).toContain('</a> closes <b>');
    expect(checkXml('<a>\n  <b></b>\n')!.message).toContain('<a> is never closed');
    expect(checkXml('<a/><b/>')!.message).toContain('second root');
    expect(checkXml('<a>\n<!-- open')!.line).toBe(2);
  });
});

describe('HTML entities', () => {
  it('encodes and decodes', () => {
    expect(encodeEntities('<a href="x">Tom & Jerry\'s</a>')).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(encodeEntities('café ✓', true)).toBe('caf&#xE9; &#x2713;');
    expect(decodeEntities('&lt;b&gt; &amp;amp; &eacute;&#233;&#xE9; &copy; &bogus;')).toBe('<b> &amp; ééé © &bogus;');
  });
});
