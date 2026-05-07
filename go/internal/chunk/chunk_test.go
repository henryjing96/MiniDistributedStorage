package chunk

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestManifestRoundTrip(t *testing.T) {
	cases := []int{0, 1, 1024, 4*1024*1024 - 1, 4 * 1024 * 1024, 4*1024*1024 + 17}
	for _, sz := range cases {
		t.Run("", func(t *testing.T) {
			data := make([]byte, sz)
			if _, err := rand.Read(data); err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			p := filepath.Join(dir, "f")
			if err := os.WriteFile(p, data, 0o644); err != nil {
				t.Fatal(err)
			}
			m, err := New(4 * 1024 * 1024).Manifest(p, "f")
			if err != nil {
				t.Fatal(err)
			}
			if m.Size != int64(sz) {
				t.Fatalf("size: got %d, want %d", m.Size, sz)
			}
			fullSha := sha256.Sum256(data)
			if m.SHA256 != hex.EncodeToString(fullSha[:]) {
				t.Fatalf("file sha mismatch")
			}
			// reconstruct content from blocks
			var off int
			for _, b := range m.Blocks {
				blockSha := sha256.Sum256(data[off : off+b.Size])
				if b.SHA256 != hex.EncodeToString(blockSha[:]) {
					t.Fatalf("block %d sha mismatch", b.Index)
				}
				off += b.Size
			}
			if off != sz {
				t.Fatalf("blocks cover %d, want %d", off, sz)
			}
		})
	}
}
