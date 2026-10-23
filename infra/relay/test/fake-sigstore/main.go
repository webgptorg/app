// Command fake-sigstore is a test-only stand-in for Sigstore's public-good instance: it plays Fulcio, the CT log,
// Rekor and the timestamp authority in one process, so deploy-test.sh can sign test images the way cosign does in
// release-relay.yml (a v0.3 bundle over a DSSE in-toto statement, attached as an OCI referrer) under any GitHub
// workflow identity. The relay hosts then verify them with the real cosign and the exact production flags; only the
// trusted root differs. Keys live in the state directory for one test run and are never used anywhere else.
//
// The CA, Rekor and TSA code follows sigstore-go's pkg/testing/ca (Apache-2.0); unlike it, the leaf certificate
// carries a URI SAN, GitHub's Fulcio extensions and an embedded SCT, as Fulcio's certificates do.
package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/digitorus/timestamp"
	"github.com/go-openapi/runtime"
	ct "github.com/google/certificate-transparency-go"
	cttls "github.com/google/certificate-transparency-go/tls"
	ctx509 "github.com/google/certificate-transparency-go/x509"
	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/static"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"github.com/secure-systems-lab/go-securesystemslib/dsse"
	protobundle "github.com/sigstore/protobuf-specs/gen/pb-go/bundle/v1"
	protocommon "github.com/sigstore/protobuf-specs/gen/pb-go/common/v1"
	protodsse "github.com/sigstore/protobuf-specs/gen/pb-go/dsse"
	protorekor "github.com/sigstore/protobuf-specs/gen/pb-go/rekor/v1"
	"github.com/sigstore/rekor/pkg/generated/models"
	"github.com/sigstore/rekor/pkg/pki"
	rekortypes "github.com/sigstore/rekor/pkg/types"
	dsseentry "github.com/sigstore/rekor/pkg/types/dsse"
	_ "github.com/sigstore/rekor/pkg/types/dsse/v0.0.1"
	"github.com/sigstore/rekor/pkg/util"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore/pkg/cryptoutils"
	"github.com/sigstore/sigstore/pkg/signature"
	sigdsse "github.com/sigstore/sigstore/pkg/signature/dsse"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/protobuf/encoding/protojson"
)

const (
	bundleMediaType   = "application/vnd.dev.sigstore.bundle.v0.3+json"
	signPredicateType = "https://sigstore.dev/cosign/sign/v1"
	rekorOrigin       = "rekor.localhost"
	stateFile         = "state.json"
	trustedRootFile   = "trusted_root.json"
)

// Registry credentials come from $DOCKER_CONFIG, as for cosign.
var registryAuth = remote.WithAuthFromKeychain(authn.DefaultKeychain)

var (
	oidIssuer          = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 1}
	oidWorkflowTrigger = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 2}
	oidWorkflowSHA     = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 3}
	oidWorkflowName    = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 4}
	oidWorkflowRepo    = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 5}
	oidWorkflowRef     = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 6}
	oidIssuerV2        = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 8}
	oidBuildSignerURI  = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 9}
	oidBuildSignerSHA  = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 10}
	oidRunnerEnv       = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 11}
	oidSourceRepoURI   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 12}
	oidSourceRepoSHA   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 13}
	oidSourceRepoRef   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 14}
	oidBuildConfigURI  = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 18}
	oidBuildConfigSHA  = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 19}
	oidBuildTrigger    = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 20}
	oidPrecertPoison   = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 11129, 2, 4, 3}
	oidSCTList         = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 11129, 2, 4, 2}
)

// state is the key material of one fake instance, PEM-encoded.
type state struct {
	RootKey, RootCert, FulcioKey, FulcioCert, TSAKey, TSACert, TSARootCert, CTLogKey, RekorKey string
	NotBefore                                                                                  time.Time
}

func main() {
	if len(os.Args) < 2 {
		fail(errors.New("usage: fake-sigstore init|sign|push|htpasswd [flags]"))
	}
	var err error
	switch os.Args[1] {
	case "init":
		err = runInit(os.Args[2:])
	case "sign":
		err = runSign(os.Args[2:])
	case "push":
		err = runPush(os.Args[2:])
	case "htpasswd":
		err = runHtpasswd(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "fake-sigstore:", err)
	os.Exit(1)
}

func runInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	_ = fs.Parse(args)
	if *dir == "" {
		return errors.New("-dir is required")
	}
	notBefore := time.Now().Add(-time.Hour).Truncate(time.Second)
	notAfter := notBefore.Add(48 * time.Hour)

	rootKey, rootCert, err := newCA("fake-sigstore", nil, nil, notBefore, notAfter, nil)
	if err != nil {
		return err
	}
	fulcioKey, fulcioCert, err := newCA("fake-sigstore-intermediate", rootCert, rootKey, notBefore, notAfter,
		[]x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning})
	if err != nil {
		return err
	}
	tsaRootKey, tsaRootCert, err := newCA("fake-tsa", nil, nil, notBefore, notAfter, nil)
	if err != nil {
		return err
	}
	tsaKey, tsaCert, err := newTSALeaf(tsaRootCert, tsaRootKey, notBefore, notAfter)
	if err != nil {
		return err
	}
	ctKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	rekorKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	s := state{
		RootKey: keyPEM(rootKey), RootCert: certPEM(rootCert),
		FulcioKey: keyPEM(fulcioKey), FulcioCert: certPEM(fulcioCert),
		TSAKey: keyPEM(tsaKey), TSACert: certPEM(tsaCert), TSARootCert: certPEM(tsaRootCert),
		CTLogKey: keyPEM(ctKey), RekorKey: keyPEM(rekorKey),
		NotBefore: notBefore,
	}
	if err := os.MkdirAll(*dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(*dir, stateFile), raw, 0o600); err != nil {
		return err
	}

	trustedRoot, err := buildTrustedRoot(rootCert, fulcioCert, tsaRootCert, tsaCert, &ctKey.PublicKey,
		&rekorKey.PublicKey, notBefore)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(*dir, trustedRootFile), trustedRoot, 0o644)
}

func buildTrustedRoot(rootCert, fulcioCert, tsaRootCert, tsaCert *x509.Certificate, ctKey, rekorKey *ecdsa.PublicKey,
	notBefore time.Time) ([]byte, error) {
	ctID, err := logID(ctKey)
	if err != nil {
		return nil, err
	}
	rekorID, err := logID(rekorKey)
	if err != nil {
		return nil, err
	}
	tr, err := root.NewTrustedRoot(root.TrustedRootMediaType01,
		[]root.CertificateAuthority{&root.FulcioCertificateAuthority{
			Root: rootCert, Intermediates: []*x509.Certificate{fulcioCert},
			ValidityPeriodStart: notBefore, URI: "https://fulcio.fake-sigstore.test",
		}},
		map[string]*root.TransparencyLog{hex.EncodeToString(ctID): {
			BaseURL: "https://ctfe.fake-sigstore.test", ID: ctID, ValidityPeriodStart: notBefore,
			HashFunc: crypto.SHA256, PublicKey: ctKey, SignatureHashFunc: crypto.SHA256,
		}},
		[]root.TimestampingAuthority{&root.SigstoreTimestampingAuthority{
			Root: tsaRootCert, Leaf: tsaCert, ValidityPeriodStart: notBefore,
			URI: "https://tsa.fake-sigstore.test",
		}},
		map[string]*root.TransparencyLog{hex.EncodeToString(rekorID): {
			BaseURL: "https://" + rekorOrigin, ID: rekorID, ValidityPeriodStart: notBefore,
			HashFunc: crypto.SHA256, PublicKey: rekorKey, SignatureHashFunc: crypto.SHA256,
		}},
	)
	if err != nil {
		return nil, err
	}
	return json.MarshalIndent(tr, "", "  ")
}

// runPush uploads a `docker save` archive to the test registry and prints its digest, so the test needs no registry
// login or trust settings in the Docker daemon.
func runPush(args []string) error {
	fs := flag.NewFlagSet("push", flag.ExitOnError)
	archive := fs.String("archive", "", "image archive from docker save")
	ref := fs.String("ref", "", "where to push it (registry/repository:tag)")
	ageDays := fs.Int("age-days", 0, "backdate the image's build time by this many days")
	_ = fs.Parse(args)
	tag, err := name.NewTag(*ref)
	if err != nil {
		return fmt.Errorf("-ref: %w", err)
	}
	img, err := tarball.ImageFromPath(*archive, nil)
	if err != nil {
		return err
	}
	if *ageDays > 0 {
		img, err = mutate.CreatedAt(img, v1.Time{Time: time.Now().AddDate(0, 0, -*ageDays)})
		if err != nil {
			return err
		}
	}
	if err := remote.Write(tag, img, registryAuth); err != nil {
		return err
	}
	digest, err := img.Digest()
	if err != nil {
		return err
	}
	fmt.Println(digest.String())
	return nil
}

// runHtpasswd prints a bcrypt htpasswd line for the test registry's pull account.
func runHtpasswd(args []string) error {
	fs := flag.NewFlagSet("htpasswd", flag.ExitOnError)
	user := fs.String("user", "", "user name")
	password := fs.String("password", "", "password")
	_ = fs.Parse(args)
	if *user == "" || *password == "" {
		return errors.New("-user and -password are required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(*password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	fmt.Printf("%s:%s\n", *user, hash)
	return nil
}

// identity is what Fulcio would read from a GitHub Actions OIDC token.
type identity struct {
	issuer, repository, workflowPath, ref, sha, trigger string
}

func (id identity) san() string {
	return fmt.Sprintf("https://github.com/%s/%s@%s", id.repository, id.workflowPath, id.ref)
}

func runSign(args []string) error {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	dir := fs.String("dir", "", "state directory")
	image := fs.String("image", "", "image to sign, by digest (registry/repository@sha256:...)")
	id := identity{}
	fs.StringVar(&id.issuer, "issuer", "https://token.actions.githubusercontent.com", "OIDC issuer")
	fs.StringVar(&id.repository, "repository", "webgptorg/app", "GitHub repository (owner/name)")
	fs.StringVar(&id.workflowPath, "workflow", ".github/workflows/release-relay.yml", "workflow path")
	fs.StringVar(&id.ref, "ref", "refs/heads/main", "git ref the workflow ran on")
	fs.StringVar(&id.sha, "sha", strings.Repeat("0", 40), "commit")
	fs.StringVar(&id.trigger, "trigger", "push", "event that triggered the workflow")
	noTimestamp := fs.Bool("no-timestamp", false, "leave out the RFC 3161 timestamp")
	_ = fs.Parse(args)
	if *dir == "" || *image == "" {
		return errors.New("-dir and -image are required")
	}
	digestRef, err := name.NewDigest(*image)
	if err != nil {
		return fmt.Errorf("-image must name a digest: %w", err)
	}
	s, err := loadState(*dir)
	if err != nil {
		return err
	}

	statement, err := json.Marshal(map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []any{map[string]any{"name": digestRef.Context().Name(), "digest": map[string]string{"sha256": strings.TrimPrefix(digestRef.DigestStr(), "sha256:")}}},
		"predicateType": signPredicateType,
		"predicate":     map[string]any{},
	})
	if err != nil {
		return err
	}

	now := time.Now()
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	leaf, err := s.issueLeaf(id, &leafKey.PublicKey, now)
	if err != nil {
		return err
	}

	signer, err := signature.LoadECDSASignerVerifier(leafKey, crypto.SHA256)
	if err != nil {
		return err
	}
	envelopeSigner, err := dsse.NewEnvelopeSigner(&sigdsse.SignerAdapter{SignatureSigner: signer, Pub: &leafKey.PublicKey})
	if err != nil {
		return err
	}
	envelope, err := envelopeSigner.SignPayload(context.Background(), "application/vnd.in-toto+json", statement)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(envelope.Signatures[0].Sig)
	if err != nil {
		return err
	}

	tlogEntry, err := s.rekorEntry(leaf, envelope, sig, now)
	if err != nil {
		return err
	}

	material := &protobundle.VerificationMaterial{
		Content:     &protobundle.VerificationMaterial_Certificate{Certificate: &protocommon.X509Certificate{RawBytes: leaf.Raw}},
		TlogEntries: []*protorekor.TransparencyLogEntry{tlogEntry},
	}
	if !*noTimestamp {
		tsr, err := s.timestamp(sig, now)
		if err != nil {
			return err
		}
		material.TimestampVerificationData = &protobundle.TimestampVerificationData{
			Rfc3161Timestamps: []*protocommon.RFC3161SignedTimestamp{{SignedTimestamp: tsr}},
		}
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return err
	}
	b := &protobundle.Bundle{
		MediaType:            bundleMediaType,
		VerificationMaterial: material,
		Content: &protobundle.Bundle_DsseEnvelope{DsseEnvelope: &protodsse.Envelope{
			Payload:     payload,
			PayloadType: envelope.PayloadType,
			Signatures:  []*protodsse.Signature{{Sig: sig}},
		}},
	}
	bundleJSON, err := protojson.Marshal(b)
	if err != nil {
		return err
	}
	if err := attachBundle(digestRef, bundleJSON); err != nil {
		return err
	}
	fmt.Printf("signed %s as %s\n", digestRef.String(), id.san())
	return nil
}

// issueLeaf issues a Fulcio-style code signing certificate with an embedded SCT: the CT log signs the precertificate's
// TBS, then the final certificate is the same TBS plus the SCT list extension, which is what verifiers reconstruct.
func (s *loadedState) issueLeaf(id identity, pub *ecdsa.PublicKey, now time.Time) (*x509.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	san := id.san()
	sanURI, err := url.Parse(san)
	if err != nil {
		return nil, err
	}
	der := func(value string) []byte {
		out, err := asn1.MarshalWithParams(value, "utf8")
		if err != nil {
			panic(err)
		}
		return out
	}
	repoURI := "https://github.com/" + id.repository
	extensions := []pkix.Extension{
		{Id: oidIssuer, Value: []byte(id.issuer)},
		{Id: oidWorkflowTrigger, Value: []byte(id.trigger)},
		{Id: oidWorkflowSHA, Value: []byte(id.sha)},
		{Id: oidWorkflowName, Value: []byte("Release relay")},
		{Id: oidWorkflowRepo, Value: []byte(id.repository)},
		{Id: oidWorkflowRef, Value: []byte(id.ref)},
		{Id: oidIssuerV2, Value: der(id.issuer)},
		{Id: oidBuildSignerURI, Value: der(san)},
		{Id: oidBuildSignerSHA, Value: der(id.sha)},
		{Id: oidRunnerEnv, Value: der("github-hosted")},
		{Id: oidSourceRepoURI, Value: der(repoURI)},
		{Id: oidSourceRepoSHA, Value: der(id.sha)},
		{Id: oidSourceRepoRef, Value: der(id.ref)},
		{Id: oidBuildConfigURI, Value: der(san)},
		{Id: oidBuildConfigSHA, Value: der(id.sha)},
		{Id: oidBuildTrigger, Value: der(id.trigger)},
	}
	template := &x509.Certificate{
		SerialNumber:   serial,
		NotBefore:      now.Add(-time.Minute),
		NotAfter:       now.Add(10 * time.Minute),
		KeyUsage:       x509.KeyUsageDigitalSignature,
		ExtKeyUsage:    []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning},
		URIs:           []*url.URL{sanURI},
		AuthorityKeyId: s.fulcioCert.SubjectKeyId,
	}

	template.ExtraExtensions = append(append([]pkix.Extension{}, extensions...),
		pkix.Extension{Id: oidPrecertPoison, Critical: true, Value: asn1.NullBytes})
	precertDER, err := x509.CreateCertificate(rand.Reader, template, s.fulcioCert, pub, s.fulcioKey)
	if err != nil {
		return nil, err
	}
	precert, err := ctx509.ParseCertificate(precertDER)
	if err != nil {
		return nil, err
	}
	tbs, err := ctx509.RemoveCTPoison(precert.RawTBSCertificate)
	if err != nil {
		return nil, err
	}

	issuerKeyHash := sha256.Sum256(s.fulcioCert.RawSubjectPublicKeyInfo)
	ctID, err := logID(&s.ctKey.PublicKey)
	if err != nil {
		return nil, err
	}
	sct := ct.SignedCertificateTimestamp{
		SCTVersion: ct.V1,
		LogID:      ct.LogID{KeyID: [32]byte(ctID)},
		Timestamp:  uint64(now.UnixMilli()),
	}
	input, err := ct.SerializeSCTSignatureInput(sct, ct.LogEntry{Leaf: ct.MerkleTreeLeaf{
		Version:  ct.V1,
		LeafType: ct.TimestampedEntryLeafType,
		TimestampedEntry: &ct.TimestampedEntry{
			Timestamp: sct.Timestamp,
			EntryType: ct.PrecertLogEntryType,
			PrecertEntry: &ct.PreCert{
				IssuerKeyHash:  issuerKeyHash,
				TBSCertificate: tbs,
			},
		},
	}})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(input)
	sctSig, err := ecdsa.SignASN1(rand.Reader, s.ctKey, digest[:])
	if err != nil {
		return nil, err
	}
	sct.Signature = ct.DigitallySigned{
		Algorithm: cttls.SignatureAndHashAlgorithm{Hash: cttls.SHA256, Signature: cttls.ECDSA},
		Signature: sctSig,
	}
	sctBytes, err := cttls.Marshal(sct)
	if err != nil {
		return nil, err
	}
	list, err := cttls.Marshal(ctx509.SignedCertificateTimestampList{
		SCTList: []ctx509.SerializedSCT{{Val: sctBytes}},
	})
	if err != nil {
		return nil, err
	}
	listDER, err := asn1.Marshal(list)
	if err != nil {
		return nil, err
	}

	template.ExtraExtensions = append(append([]pkix.Extension{}, extensions...),
		pkix.Extension{Id: oidSCTList, Value: listDER})
	leafDER, err := x509.CreateCertificate(rand.Reader, template, s.fulcioCert, pub, s.fulcioKey)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(leafDER)
}

// rekorEntry builds a Rekor v1 dsse entry for a one-entry log: a signed entry timestamp and an inclusion proof whose
// root is the leaf itself, with a checkpoint signed by the log key.
func (s *loadedState) rekorEntry(leaf *x509.Certificate, envelope *dsse.Envelope, sig []byte, now time.Time) (*protorekor.TransparencyLogEntry, error) {
	leafPEM, err := cryptoutils.MarshalCertificateToPEM(leaf)
	if err != nil {
		return nil, err
	}
	envelopeJSON, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	proposed, err := rekortypes.NewProposedEntry(ctx, dsseentry.KIND, "0.0.1", rekortypes.ArtifactProperties{
		ArtifactBytes:  envelopeJSON,
		SignatureBytes: sig,
		PublicKeyBytes: [][]byte{leafPEM},
		PKIFormat:      string(pki.X509),
	})
	if err != nil {
		return nil, err
	}
	impl, err := rekortypes.CreateVersionedEntry(proposed)
	if err != nil {
		return nil, err
	}
	canonical, err := rekortypes.CanonicalizeEntry(ctx, impl)
	if err != nil {
		return nil, err
	}
	if _, err := models.UnmarshalProposedEntry(bytes.NewReader(canonical), runtime.JSONConsumer()); err != nil {
		return nil, err
	}

	rekorID, err := logID(&s.rekorKey.PublicKey)
	if err != nil {
		return nil, err
	}
	integratedTime := now.Unix()
	setPayload, err := json.Marshal(map[string]any{
		"body":           base64.StdEncoding.EncodeToString(canonical),
		"integratedTime": integratedTime,
		"logID":          hex.EncodeToString(rekorID),
		"logIndex":       0,
	})
	if err != nil {
		return nil, err
	}
	canonicalSET, err := jsoncanonicalizer.Transform(setPayload)
	if err != nil {
		return nil, err
	}
	rekorSigner, err := signature.LoadECDSASignerVerifier(s.rekorKey, crypto.SHA256)
	if err != nil {
		return nil, err
	}
	set, err := rekorSigner.SignMessage(bytes.NewReader(canonicalSET))
	if err != nil {
		return nil, err
	}

	leafHash := sha256.Sum256(append([]byte{0}, canonical...))
	checkpoint, err := util.CreateAndSignCheckpoint(ctx, rekorOrigin, 1, 1, leafHash[:], rekorSigner)
	if err != nil {
		return nil, err
	}
	return &protorekor.TransparencyLogEntry{
		LogIndex:          0,
		LogId:             &protocommon.LogId{KeyId: rekorID},
		KindVersion:       &protorekor.KindVersion{Kind: dsseentry.KIND, Version: "0.0.1"},
		IntegratedTime:    integratedTime,
		InclusionPromise:  &protorekor.InclusionPromise{SignedEntryTimestamp: set},
		CanonicalizedBody: canonical,
		InclusionProof: &protorekor.InclusionProof{
			LogIndex:   0,
			RootHash:   leafHash[:],
			TreeSize:   1,
			Hashes:     [][]byte{},
			Checkpoint: &protorekor.Checkpoint{Envelope: string(checkpoint)},
		},
	}, nil
}

func (s *loadedState) timestamp(sig []byte, now time.Time) ([]byte, error) {
	request, err := timestamp.CreateRequest(bytes.NewReader(sig), &timestamp.RequestOptions{Hash: crypto.SHA256})
	if err != nil {
		return nil, err
	}
	parsed, err := timestamp.ParseRequest(request)
	if err != nil {
		return nil, err
	}
	ts := timestamp.Timestamp{
		HashAlgorithm: parsed.HashAlgorithm,
		HashedMessage: parsed.HashedMessage,
		Time:          now,
		Policy:        asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 2},
	}
	return ts.CreateResponseWithOpts(s.tsaCert, s.tsaKey, crypto.SHA256)
}

// attachBundle writes the bundle as cosign's WriteAttestationNewBundleFormat does: an OCI 1.1 manifest with the
// image as its subject and the bundle as its only layer. go-containerregistry also updates the referrers fallback tag
// when the registry has no referrers API.
func attachBundle(target name.Digest, bundleJSON []byte) error {
	desc, err := remote.Head(target, registryAuth)
	if err != nil {
		return err
	}
	layer := static.NewLayer(bundleJSON, types.MediaType(bundleMediaType))
	if err := remote.WriteLayer(target.Context(), layer, registryAuth); err != nil {
		return err
	}
	config := static.NewLayer([]byte("{}"), "application/vnd.oci.empty.v1+json")
	if err := remote.WriteLayer(target.Context(), config, registryAuth); err != nil {
		return err
	}
	layerDigest, _ := layer.Digest()
	layerSize, _ := layer.Size()
	configDigest, _ := config.Digest()
	manifest := referrerManifest{
		Manifest: v1.Manifest{
			SchemaVersion: 2,
			MediaType:     types.OCIManifestSchema1,
			Config: v1.Descriptor{
				MediaType: "application/vnd.oci.empty.v1+json", ArtifactType: bundleMediaType,
				Digest: configDigest, Size: 2,
			},
			Layers:  []v1.Descriptor{{MediaType: types.MediaType(bundleMediaType), Digest: layerDigest, Size: layerSize}},
			Subject: &v1.Descriptor{MediaType: desc.MediaType, Digest: desc.Digest, Size: desc.Size},
			Annotations: map[string]string{
				"org.opencontainers.image.created":  time.Now().UTC().Format(time.RFC3339),
				"dev.sigstore.bundle.content":       "dsse-envelope",
				"dev.sigstore.bundle.predicateType": signPredicateType,
			},
		},
		ArtifactType: bundleMediaType,
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	manifestDigest, _, err := v1.SHA256(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	return remote.Put(target.Context().Digest(manifestDigest.String()), manifest, registryAuth)
}

type referrerManifest struct {
	v1.Manifest
	ArtifactType string `json:"artifactType,omitempty"`
}

func (r referrerManifest) RawManifest() ([]byte, error) { return json.Marshal(r) }

func (r referrerManifest) MediaType() (types.MediaType, error) { return types.OCIManifestSchema1, nil }

type loadedState struct {
	fulcioKey, tsaKey, ctKey, rekorKey *ecdsa.PrivateKey
	fulcioCert, tsaCert                *x509.Certificate
}

func loadState(dir string) (*loadedState, error) {
	raw, err := os.ReadFile(filepath.Join(dir, stateFile))
	if err != nil {
		return nil, err
	}
	var s state
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	out := &loadedState{}
	for _, k := range []struct {
		pem string
		dst **ecdsa.PrivateKey
	}{{s.FulcioKey, &out.fulcioKey}, {s.TSAKey, &out.tsaKey}, {s.CTLogKey, &out.ctKey}, {s.RekorKey, &out.rekorKey}} {
		block, _ := pem.Decode([]byte(k.pem))
		if block == nil {
			return nil, errors.New("bad key in state")
		}
		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		*k.dst = key
	}
	for _, c := range []struct {
		pem string
		dst **x509.Certificate
	}{{s.FulcioCert, &out.fulcioCert}, {s.TSACert, &out.tsaCert}} {
		block, _ := pem.Decode([]byte(c.pem))
		if block == nil {
			return nil, errors.New("bad certificate in state")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, err
		}
		*c.dst = cert
	}
	return out, nil
}

func newCA(cn string, parent *x509.Certificate, parentKey *ecdsa.PrivateKey, notBefore, notAfter time.Time,
	eku []x509.ExtKeyUsage) (*ecdsa.PrivateKey, *x509.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: cn, Organization: []string{"fake-sigstore.test"}},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           eku,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	if parent == nil {
		parent, parentKey = template, key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, parentKey)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	return key, cert, err
}

func newTSALeaf(parent *x509.Certificate, parentKey *ecdsa.PrivateKey, notBefore, notAfter time.Time) (*ecdsa.PrivateKey, *x509.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	eku, err := asn1.Marshal([]asn1.ObjectIdentifier{{1, 3, 6, 1, 5, 5, 7, 3, 8}})
	if err != nil {
		return nil, nil, err
	}
	template := &x509.Certificate{
		SerialNumber:    big.NewInt(time.Now().UnixNano()),
		Subject:         pkix.Name{CommonName: "fake-tsa-leaf"},
		NotBefore:       notBefore,
		NotAfter:        notAfter,
		KeyUsage:        x509.KeyUsageDigitalSignature,
		ExtraExtensions: []pkix.Extension{{Id: asn1.ObjectIdentifier{2, 5, 29, 37}, Critical: true, Value: eku}},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, parentKey)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	return key, cert, err
}

func logID(pub crypto.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return sum[:], nil
}

func keyPEM(key *ecdsa.PrivateKey) string {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		panic(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

func certPEM(cert *x509.Certificate) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}))
}
