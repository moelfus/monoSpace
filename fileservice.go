package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Document is a text file loaded from disk. An empty Path means the user
// cancelled the dialog.
type Document struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// FileService exposes file open/save to the frontend.
type FileService struct {
	app *application.App
}

func (f *FileService) markdownFilters() func(d *application.OpenFileDialogStruct) {
	return func(d *application.OpenFileDialogStruct) {
		d.AddFilter("Markdown & Text", "*.md;*.markdown;*.txt")
		d.AddFilter("All files", "*.*")
	}
}

// Open shows a native file dialog and loads the chosen file.
func (f *FileService) Open() (Document, error) {
	d := f.app.Dialog.OpenFile().SetTitle("Open")
	f.markdownFilters()(d)
	path, err := d.PromptForSingleSelection()
	if err != nil || path == "" {
		return Document{}, nil
	}
	return f.OpenPath(path)
}

// OpenPath loads a file by path.
func (f *FileService) OpenPath(path string) (Document, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Document{}, err
	}
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM
	return Document{Path: path, Content: string(b)}, nil
}

// Save writes content to an existing path.
func (f *FileService) Save(path, content string) error {
	if path == "" {
		return errors.New("no path")
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// SaveAs asks for a destination, writes the file and returns its path.
// It returns an empty path if the user cancelled.
func (f *FileService) SaveAs(suggestedName, content string) (string, error) {
	if suggestedName == "" {
		suggestedName = "Untitled.md"
	}
	d := f.app.Dialog.SaveFile().
		SetMessage("Save").
		SetFilename(filepath.Base(suggestedName)).
		AddFilter("Markdown", "*.md")
	path, err := d.PromptForSingleSelection()
	if err != nil || path == "" {
		return "", nil
	}
	if filepath.Ext(path) == "" {
		path += ".md"
	}
	return path, f.Save(path, content)
}

// Entry is a file or folder in the library.
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Rel   string `json:"rel"`
	IsDir bool   `json:"isDir"`
}

const maxLibraryFiles = 5000

func isTextFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".markdown", ".txt":
		return true
	}
	return false
}

func isHidden(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules"
}

// PickFolder shows a native folder dialog. It returns "" if the user cancelled.
func (f *FileService) PickFolder() (string, error) {
	path, err := f.app.Dialog.OpenFile().
		SetTitle("Open folder").
		CanChooseFiles(false).
		CanChooseDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return "", nil
	}
	return path, nil
}

// ListDir returns the sub-folders and text files directly inside dir,
// folders first, each group sorted case-insensitively.
func (f *FileService) ListDir(dir string) ([]Entry, error) {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var dirs, files []Entry
	for _, it := range items {
		name := it.Name()
		if isHidden(name) {
			continue
		}
		e := Entry{Name: name, Path: filepath.Join(dir, name), IsDir: it.IsDir()}
		if it.IsDir() {
			dirs = append(dirs, e)
		} else if isTextFile(name) {
			files = append(files, e)
		}
	}
	less := func(s []Entry) func(i, j int) bool {
		return func(i, j int) bool { return strings.ToLower(s[i].Name) < strings.ToLower(s[j].Name) }
	}
	sort.Slice(dirs, less(dirs))
	sort.Slice(files, less(files))
	return append(dirs, files...), nil
}

// ListFiles walks root recursively and returns all text files (for the quick switcher).
func (f *FileService) ListFiles(root string) ([]Entry, error) {
	var out []Entry
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if p != root && isHidden(d.Name()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !isTextFile(d.Name()) {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		out = append(out, Entry{Name: d.Name(), Path: p, Rel: rel})
		if len(out) >= maxLibraryFiles {
			return fs.SkipAll
		}
		return nil
	})
	return out, err
}

// Quit closes the application (used by vim's :q).
func (f *FileService) Quit() {
	f.app.Quit()
}
