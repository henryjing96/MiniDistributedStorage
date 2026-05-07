package chunk

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"

	"minidss/internal/proto"
)

type Chunker struct {
	BlockSize int
}

func New(blockSize int) *Chunker {
	if blockSize <= 0 {
		blockSize = proto.DefaultBlockSize
	}
	return &Chunker{BlockSize: blockSize}
}

// Manifest reads the file at path and produces a Manifest with per-block
// SHA-256 and a whole-file SHA-256.
func (c *Chunker) Manifest(path, name string) (*proto.Manifest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}

	fileH := sha256.New()
	buf := make([]byte, c.BlockSize)
	var blocks []proto.BlockInfo
	idx := 0
	for {
		n, err := io.ReadFull(f, buf)
		if n > 0 {
			bh := sha256.New()
			bh.Write(buf[:n])
			fileH.Write(buf[:n])
			blocks = append(blocks, proto.BlockInfo{
				Index:  idx,
				Size:   n,
				SHA256: hex.EncodeToString(bh.Sum(nil)),
			})
			idx++
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read: %w", err)
		}
	}

	return &proto.Manifest{
		Name:      name,
		Size:      info.Size(),
		SHA256:    hex.EncodeToString(fileH.Sum(nil)),
		BlockSize: c.BlockSize,
		Blocks:    blocks,
	}, nil
}

func HashBytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
