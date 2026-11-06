#!/usr/bin/env python3
"""Read-only EPUB discovery and bounded structural retrieval. No network or AI calls."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import sqlite3
import sys
import time
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile

META_LIMIT = 2 * 1024 * 1024
CHAPTER_LIMIT = 4 * 1024 * 1024
SKIP_DIRS = {'.git', '.cache', 'node_modules', '__pycache__'}


def local(tag):
    return tag.rsplit('}', 1)[-1]


def text(node):
    return ' '.join(''.join(node.itertext()).split())


def resolve(base, href):
    url = urlsplit(href)
    if url.scheme or url.netloc or '\\' in href or '\x00' in href:
        raise ValueError('Unsupported EPUB content link')
    name = posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(url.path))) if url.path else base
    if name.startswith(('../', '/')) or name == '..':
        raise ValueError('Content link leaves EPUB archive')
    return name, unquote(url.fragment)


class Book:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        try:
            names = self.zip.namelist()
            if len(names) > 50000 or len(names) != len(set(names)):
                raise ValueError('EPUB directory is oversized or ambiguous')
            container = self.xml('META-INF/container.xml')
            packages = [n.attrib['full-path'] for n in container.iter()
                        if local(n.tag) == 'rootfile' and n.attrib.get('full-path')]
            if not packages:
                raise ValueError('No EPUB package document')
            self.opf = packages[0]
            package = self.xml(self.opf)
            metadata = next((n for n in package if local(n.tag) == 'metadata'), None)
            fields = list(metadata) if metadata is not None else []
            self.title = next((text(n) for n in fields if local(n.tag) == 'title' and text(n)), Path(path).stem)[:240]
            self.title_source = 'metadata' if any(local(n.tag) == 'title' and text(n) for n in fields) else 'filename'
            self.authors = [text(n)[:120] for n in fields if local(n.tag) == 'creator'][:4]
            self.items = {n.attrib['id']: n.attrib for n in package.iter()
                          if local(n.tag) == 'item' and 'id' in n.attrib and 'href' in n.attrib}
            spine = next((n for n in package if local(n.tag) == 'spine'), None)
            self.spine = [self.items[n.attrib['idref']] for n in (list(spine) if spine is not None else [])
                          if n.attrib.get('idref') in self.items]
            self.ncx = self.items.get(spine.attrib.get('toc', '')) if spine is not None else None
        except Exception:
            self.zip.close()
            raise

    def close(self):
        self.zip.close()

    def read(self, name, limit):
        info = self.zip.getinfo(name)
        if info.file_size > limit or info.flag_bits & 1:
            raise ValueError('EPUB entry is encrypted or exceeds local read limit')
        with self.zip.open(info) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError('EPUB entry exceeds local read limit')
        return data

    def xml(self, name, limit=META_LIMIT):
        data = self.read(name, limit)
        if b'<!ENTITY' in data.upper():
            raise ValueError('XML entities are unsupported')
        return ET.fromstring(data)

    def contents(self):
        entries = []
        nav = next((i for i in self.items.values() if 'nav' in i.get('properties', '').split()), None)
        if nav:
            name, _ = resolve(self.opf, nav['href'])
            document = self.xml(name)
            nodes = [n for n in document.iter() if local(n.tag) == 'nav']
            toc = next((n for n in nodes if 'toc' in n.attrib.get('{http://www.idpf.org/2007/ops}type', '').split()), None)
            if toc is not None:
                def walk(node, depth=0):
                    for child in node:
                        if local(child.tag) == 'a' and child.attrib.get('href'):
                            path, anchor = resolve(name, child.attrib['href'])
                            entries.append(dict(title=text(child)[:240], path=path, anchor=anchor, depth=max(0, depth-1)))
                        else:
                            walk(child, depth + (local(child.tag) == 'ol'))
                walk(toc)
        if not entries:
            ncx = self.ncx or next((i for i in self.items.values() if i.get('media-type') == 'application/x-dtbncx+xml'), None)
            if ncx:
                name, _ = resolve(self.opf, ncx['href'])
                document = self.xml(name)
                def walk_ncx(node, depth=0):
                    for child in node:
                        if local(child.tag) == 'navPoint':
                            label = next((n for n in child if local(n.tag) == 'navLabel'), None)
                            link = next((n for n in child if local(n.tag) == 'content'), None)
                            if link is not None and link.attrib.get('src'):
                                path, anchor = resolve(name, link.attrib['src'])
                                entries.append(dict(title=text(label)[:240] if label is not None else path, path=path, anchor=anchor, depth=depth))
                            walk_ncx(child, depth+1)
                        else:
                            walk_ncx(child, depth)
                walk_ncx(document)
        if not entries:
            for item in self.spine:
                path, anchor = resolve(self.opf, item['href'])
                entries.append(dict(title=PurePosixPath(path).stem, path=path, anchor=anchor, depth=0))
        for index, entry in enumerate(entries):
            entry['id'] = str(index)
        return entries

    def section(self, entries, index):
        entry = entries[index]
        document = self.xml(entry['path'], CHAPTER_LIMIT)
        body = next((n for n in document.iter() if local(n.tag) == 'body'), document)
        # End at the next peer/ancestor navigation target, preserving nested subsections.
        stop = next((e['anchor'] for e in entries[index+1:]
                     if e['path'] == entry['path'] and e['depth'] <= entry['depth'] and e['anchor']), None)
        parts, anchors, headings = [], {}, []
        position = 0
        def emit(value):
            nonlocal position
            if value:
                parts.append(value)
                position += len(value)
        def walk(node):
            tag = local(node.tag)
            if tag in {'script', 'style', 'head'}:
                return
            anchor = node.attrib.get('id') or node.attrib.get('{http://www.w3.org/XML/1998/namespace}id')
            if anchor:
                anchors.setdefault(anchor, position)
            heading = tag in {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
            if heading:
                headings.append(dict(title=text(node)[:240], level=int(tag[1]), offset=position, anchor=anchor))
            emit(node.text)
            for child in node:
                walk(child)
                emit(child.tail)
            if tag in {'p','div','section','li','h1','h2','h3','h4','h5','h6','br','tr'}:
                emit('\n')
        walk(body)
        content = ''.join(parts)
        if entry['anchor'] and entry['anchor'] not in anchors:
            raise ValueError('Navigation anchor is missing; inspect another section')
        start = anchors.get(entry['anchor'], 0)
        end = anchors.get(stop, len(content))
        if end <= start:
            raise ValueError('EPUB navigation targets are out of document order')
        return content[start:end], [dict(h, offset=h['offset']-start) for h in headings if start <= h['offset'] < end]


class Library:
    def __init__(self, folder, data):
        self.root = Path(folder).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError('Choose an accessible library folder in extension settings')
        home = Path(data)
        home.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(str(self.root).encode()).hexdigest()[:24]
        self.db = sqlite3.connect(home / (key + '.sqlite'))
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''CREATE TABLE IF NOT EXISTS books
            (id TEXT PRIMARY KEY, path TEXT UNIQUE, title TEXT, authors TEXT, search TEXT,
             size INTEGER, modified INTEGER, error TEXT, title_source TEXT);
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);''')

    def refresh(self):
        rows = {r['path']: r for r in self.db.execute('SELECT * FROM books')}
        seen, updated, errors = set(), 0, 0
        def fail(error):
            raise error
        with self.db:
            for directory, dirs, files in os.walk(self.root, followlinks=False, onerror=fail):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(directory)/d).is_symlink())
                for name in sorted(files):
                    path = Path(directory)/name
                    if path.suffix.lower() != '.epub' or path.is_symlink():
                        continue
                    rel = path.relative_to(self.root).as_posix()
                    stat = path.stat()
                    seen.add(rel)
                    old = rows.get(rel)
                    if old and (old['size'],old['modified']) == (stat.st_size,stat.st_mtime_ns):
                        errors += bool(old['error'])
                        continue
                    title, authors, error, title_source = path.stem, [], '', 'filename'
                    try:
                        book = Book(path)
                        try:
                            title, authors, title_source = book.title, book.authors, book.title_source
                        finally:
                            book.close()
                    except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile, RuntimeError) as exc:
                        error = str(exc)[:240]
                        errors += 1
                    identifier = hashlib.sha256(f'{self.root}\0{rel}\0{stat.st_size}\0{stat.st_mtime_ns}'.encode()).hexdigest()[:24]
                    self.db.execute('INSERT OR REPLACE INTO books VALUES (?,?,?,?,?,?,?,?,?)',
                                    (identifier,rel,title,json.dumps(authors,ensure_ascii=False),
                                     ' '.join([title,*authors,rel]).casefold(),stat.st_size,stat.st_mtime_ns,error,title_source))
                    updated += 1
            removed = set(rows)-seen
            self.db.executemany('DELETE FROM books WHERE path=?', [(p,) for p in removed])
            self.db.execute('INSERT OR REPLACE INTO state VALUES (?,?)', ('last_scan', str(time.time())))
        return dict(books=len(seen),updated=updated,removed=len(removed),errors=errors)

    def ensure_fresh(self, seconds):
        last = self.db.execute("SELECT value FROM state WHERE key='last_scan'").fetchone()
        if last is None or time.time()-float(last[0]) >= seconds:
            self.refresh()

    def titles(self, query, offset):
        terms = query.casefold().split()
        where = ' AND '.join('instr(search,?)>0' for _ in terms) or '1'
        total = self.db.execute('SELECT count(*) FROM books WHERE '+where,terms).fetchone()[0]
        records = self.db.execute('SELECT id,title,authors,error,title_source FROM books WHERE '+where+' ORDER BY title,id LIMIT 20 OFFSET ?',[*terms,offset]).fetchall()
        return dict(total=total,books=[dict(r,authors=json.loads(r['authors'])) for r in records],
                    next_offset=offset+20 if offset+20<total else None)

    def open(self, identifier):
        row = self.db.execute('SELECT * FROM books WHERE id=?',(identifier,)).fetchone()
        if not row:
            raise ValueError('Book not in this library; search titles again')
        path = (self.root/row['path']).resolve(strict=True)
        if not path.is_relative_to(self.root):
            raise ValueError('Book leaves the configured library folder')
        stat = path.stat()
        if (stat.st_size,stat.st_mtime_ns) != (row['size'],row['modified']):
            raise ValueError('Book changed; refresh and inspect its contents again')
        return Book(path), row


def execute(request):
    folder = request.get('folder','').strip()
    if not folder:
        raise ValueError('Set the EPUB library folder in Extensions → EPUB Library first')
    library = Library(folder,request['data'])
    try:
        action = request.get('action','titles')
        if action == 'refresh':
            return library.refresh()
        library.ensure_fresh(max(10,min(3600,int(request.get('refresh_seconds',60)))))
        offset = max(0,int(request.get('offset',0)))
        if action == 'titles':
            return library.titles(request.get('query',''),offset)
        book, record = library.open(request.get('book_id',''))
        try:
            entries = book.contents()
            if action == 'contents':
                return dict(book_id=record['id'],title=book.title,sections=entries[offset:offset+40],
                            next_offset=offset+40 if offset+40<len(entries) else None)
            index = int(request.get('section_id','-1'))
            if index < 0 or index >= len(entries):
                raise ValueError('Use a section ID from contents')
            content, headings = book.section(entries,index)
            if action == 'headings':
                return dict(book_id=record['id'],section_id=str(index),headings=headings[offset:offset+40],
                            next_offset=offset+40 if offset+40<len(headings) else None)
            if action != 'read':
                raise ValueError('Unknown library action')
            heading = request.get('heading_offset')
            if heading is not None:
                heading = int(heading)
                selected = next((h for h in headings if h['offset']==heading),None)
                if selected is None:
                    raise ValueError('Use a heading offset from headings')
                end = next((h['offset'] for h in headings if h['offset']>heading and h['level']<=selected['level']),len(content))
                content = content[heading:end]
            limit = max(1,min(6000,int(request.get('limit',4000))))
            fragment = entries[index]['anchor']
            location = entries[index]['path'] + ('#'+fragment if fragment else '')
            return dict(book_id=record['id'],title=book.title,authors=book.authors,section_id=str(index),
                        section=entries[index]['title'],location=location,heading_offset=heading,
                        offset=offset,text=content[offset:offset+limit],
                        next_offset=offset+limit if offset+limit<len(content) else None)
        finally:
            book.close()
    finally:
        library.db.close()


if __name__ == '__main__':
    try:
        print(json.dumps(execute(json.load(sys.stdin)),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False))
        sys.exit(1)
