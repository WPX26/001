import difflib

def diff_file(new_path, old_path, out_path):
    with open(old_path, 'r', encoding='utf-8-sig', errors='replace') as f:
        old = f.readlines()
    with open(new_path, 'r', encoding='utf-8-sig', errors='replace') as f:
        new = f.readlines()
    sm = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
    lines = []
    count = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            continue
        count += 1
        lines.append('=' * 70)
        lines.append('HUNK %s  old:%d-%d  new:%d-%d' % (tag, i1+1, i2, j1+1, j2))
        lines.append('-' * 70)
        for k in range(i1, i2):
            lines.append('OLD %5d | %s' % (k+1, old[k].rstrip('\n')))
        for k in range(j1, j2):
            lines.append('NEW %5d | %s' % (k+1, new[k].rstrip('\n')))
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print('%s: hunks=%d' % (new_path, count))

base = r'D:\Users\lenovo\Desktop\uni-preset-vue-vite - 副本 (1) - 副本'
diff_file(base + r'\memo-home.html', base + r'\_backup_20260809\memo-home.html', base + r'\_review_diff\memo-home.diff.txt')
diff_file(base + r'\connect-prototype.html', base + r'\_backup_20260809\connect-prototype.html', base + r'\_review_diff\connect-prototype.diff.txt')
diff_file(base + r'\camera-prototype.html', base + r'\_backup_20260809\camera-prototype.html', base + r'\_review_diff\camera-prototype.diff.txt')
