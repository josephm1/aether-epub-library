import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('reader',Path(__file__).resolve().parents[1]/'lib/library.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def epub(path,title='Alexander and his world',legacy=False,nav=True):
    path.parent.mkdir(parents=True,exist_ok=True)
    package='''<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>TITLE</dc:title><dc:creator>Test Author</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>NAV</manifest><spine toc="toc"><itemref idref="chapter"/></spine></package>'''.replace('TITLE',title)
    navigation='''<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#parent">Food</a><ol><li><a href="chapter.xhtml#grain">Grain</a></li><li><a href="chapter.xhtml#horses">Horses</a></li></ol></li><li><a href="chapter.xhtml#war">War</a></li></ol></nav></body></html>'''
    if legacy:
        package=package.replace('NAV','<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        navigation='''<ncx><navMap><navPoint><navLabel><text>Food</text></navLabel><content src="chapter.xhtml#parent"/><navPoint><navLabel><text>Grain</text></navLabel><content src="chapter.xhtml#grain"/></navPoint><navPoint><navLabel><text>Horses</text></navLabel><content src="chapter.xhtml#horses"/></navPoint></navPoint><navPoint><navLabel><text>War</text></navLabel><content src="chapter.xhtml#war"/></navPoint></navMap></ncx>'''
    else:
        package=package.replace('NAV','<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' if nav else '')
    chapter='''<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="parent">Food</h1><p>Supply introduction.</p><h2 id="grain">Grain</h2><p>ONLY_GRAIN barley and wheat.</p><h3 id="storage">Storage</h3><p>ONLY_STORAGE dry granaries.</p><h2 id="horses">Horses</h2><p>ONLY_HORSES fodder requirements.</p><h1 id="war">War</h1><p>ONLY_WAR mobilization.</p><script>HIDDEN_SCRIPT</script></body></html>'''
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype','application/epub+zip')
        z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
        z.writestr('OPS/book.opf',package)
        if nav:z.writestr('OPS/toc.ncx' if legacy else 'OPS/nav.xhtml',navigation)
        z.writestr('OPS/chapter.xhtml',chapter)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'books';self.root.mkdir()
        self.data=Path(self.temp.name)/'cache'
        epub(self.root/'nested/book.EPUB')
    def call(self,action='titles',**args):
        return reader.execute(dict(folder=str(self.root),data=str(self.data),action=action,**args))
    def book_id(self):return self.call()['books'][0]['id']

    def test_catalogue_is_recursive_and_reads_no_chapter_or_navigation(self):
        original=reader.Book.read;opened=[]
        def tracked(book,name,limit):opened.append(name);return original(book,name,limit)
        with patch.object(reader.Book,'read',tracked):
            listing=self.call();self.assertEqual(listing['total'],1)
            self.assertEqual(listing['books'][0]['title'],'Alexander and his world')
        self.assertEqual(opened,['META-INF/container.xml','OPS/book.opf'])
        with patch.object(reader.Book,'read',side_effect=AssertionError('Unchanged books must not reopen')):
            self.call('refresh')

    def test_added_changed_removed_and_new_library_are_discovered(self):
        old=self.book_id();epub(self.root/'new.epub','Biology')
        result=self.call('refresh');self.assertEqual(result['books'],2)
        epub(self.root/'nested/book.EPUB','A changed edition with new structure')
        self.call('refresh');ids={r['id'] for r in self.call()['books']};self.assertNotIn(old,ids)
        with self.assertRaisesRegex(ValueError,'not in this library'):self.call('contents',book_id=old)
        (self.root/'new.epub').unlink();self.assertEqual(self.call('refresh')['removed'],1)
        other=Path(self.temp.name)/'other';epub(other/'nested/book.EPUB')
        other_id=reader.execute(dict(folder=str(other),data=str(self.data),action='titles'))['books'][0]['id']
        self.assertNotIn(other_id,ids)

    def test_dynamic_refresh_is_local_and_throttled(self):
        self.book_id();epub(self.root/'new.epub','Biology')
        self.assertEqual(self.call()['total'],1)
        with patch.object(reader.time,'time',return_value=reader.time.time()+70):
            self.assertEqual(self.call()['total'],2)

    def test_nested_navigation_keeps_children_and_excludes_next_peer(self):
        identifier=self.book_id();toc=self.call('contents',book_id=identifier)['sections']
        self.assertEqual([e['depth'] for e in toc],[0,1,1,0])
        parent=self.call('read',book_id=identifier,section_id='0')['text']
        self.assertIn('ONLY_GRAIN',parent);self.assertIn('ONLY_HORSES',parent);self.assertNotIn('ONLY_WAR',parent)
        child=self.call('read',book_id=identifier,section_id='1')['text']
        self.assertIn('ONLY_STORAGE',child);self.assertNotIn('ONLY_HORSES',child)
        self.assertNotIn('HIDDEN_SCRIPT',self.call('read',book_id=identifier,section_id='3')['text'])

    def test_heading_selection_and_pagination_do_not_leak_neighbors(self):
        identifier=self.book_id();headings=self.call('headings',book_id=identifier,section_id='0')['headings']
        storage=next(h for h in headings if h['title']=='Storage')
        args=dict(book_id=identifier,section_id='0',heading_offset=storage['offset'])
        passage=self.call('read',**args)['text'];self.assertIn('ONLY_STORAGE',passage);self.assertNotIn('ONLY_HORSES',passage)
        collected='';offset=0
        while True:
            page=self.call('read',**args,offset=offset,limit=7);self.assertLessEqual(len(page['text']),7);collected+=page['text']
            if page['next_offset'] is None:break
            offset=page['next_offset']
        self.assertEqual(collected,passage)
        self.assertEqual(len(self.call('read',book_id=identifier,section_id='0',limit=100000)['text']),len(self.call('read',book_id=identifier,section_id='0')['text']))

    def test_epub2_ncx_and_spine_fallback(self):
        epub(self.root/'legacy.epub','Legacy',legacy=True)
        self.call('refresh');identifier=next(b['id'] for b in self.call()['books'] if b['title']=='Legacy')
        self.assertEqual([e['depth'] for e in self.call('contents',book_id=identifier)['sections']],[0,1,1,0])
        epub(self.root/'plain.epub','No navigation',nav=False);self.call('refresh')
        identifier=next(b['id'] for b in self.call()['books'] if b['title']=='No navigation')
        self.assertEqual(len(self.call('contents',book_id=identifier)['sections']),1)
        self.assertGreater(len(self.call('headings',book_id=identifier,section_id='0')['headings']),1)

    def test_corrupt_books_are_reported_and_symlinks_not_followed(self):
        (self.root/'bad.epub').write_text('broken')
        outside=Path(self.temp.name)/'secret.epub';epub(outside,'Secret')
        (self.root/'link.epub').symlink_to(outside)
        self.assertEqual(self.call('refresh')['errors'],1)
        self.assertEqual(self.call()['total'],2)
        self.assertNotIn('Secret',json.dumps(self.call()))

    def test_archive_bounds_entities_paths_and_missing_anchors(self):
        with self.assertRaises(ValueError):reader.resolve('OPS/nav.xhtml','../../outside')
        self.assertEqual(reader.resolve('OPS/nav.xhtml','#target'),('OPS/nav.xhtml','target'))
        identifier=self.book_id()
        with self.assertRaisesRegex(ValueError,'section ID'):self.call('read',book_id=identifier,section_id='99')
        book=reader.Book(self.root/'nested/book.EPUB')
        try:
            with self.assertRaisesRegex(ValueError,'read limit'):book.read('OPS/chapter.xhtml',1)
            entries=book.contents();entries[0]['anchor']='missing'
            with self.assertRaisesRegex(ValueError,'anchor is missing'):book.section(entries,0)
        finally:book.close()

if __name__=='__main__':unittest.main()
