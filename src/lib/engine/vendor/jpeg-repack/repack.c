/*
 * Lossless JPEG repack for PDF image streams (pdf.garrettholmes.com, AGPL-3.0-or-later;
 * links libjpeg-turbo, IJG / BSD-3-Clause / zlib licences, see README.md).
 *
 * jr_repack(): reads the DCT coefficients of a JPEG and writes the same coefficients
 *   back as a baseline sequential JPEG with optimised Huffman tables (never progressive).
 *   Markers: the source's APP0 "JFIF", APP2 "ICC_PROFILE" and APP14 "Adobe" segments
 *   are copied byte for byte, in source order; libjpeg writes no JFIF or Adobe marker of
 *   its own. Every other APPn and COM segment (EXIF, XMP, thumbnails, comments) is dropped.
 * jr_verify(): reads the coefficients of two JPEGs and compares them exactly:
 *   dimensions, precision, colour space, JFIF/Adobe flags and transform, components
 *   (ids, sampling, block counts), quantisation tables and every DCT block.
 *
 * Errors: libjpeg's error_exit traps (unreachable) after storing the message code in
 * jr_last_error(); the caller discards the instance. No setjmp, so the module needs no
 * exception handling support and no JavaScript glue. A warning (corrupt data, such as a
 * truncated scan that libjpeg would silently fill) makes the call fail (-2).
 */
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "jpeglib.h"

#define JR_OK 0
#define JR_WARNING -2
#define JR_UNSUPPORTED -3
#define JR_TOO_BIG -4

struct jr_err {
	struct jpeg_error_mgr pub;
	int warnings;
};

static int g_last_error = 0;
static int g_tamper = 0;
static unsigned char *g_out = NULL;
static unsigned long g_outlen = 0;

int jr_last_error(void) { return g_last_error; }
/* Test only: add this to the first DC coefficient of the output (proves jr_verify catches it). */
void jr_test_tamper(int t) { g_tamper = t; }
unsigned char *jr_out_ptr(void) { return g_out; }
unsigned long jr_out_len(void) { return g_outlen; }
void jr_out_free(void) {
	if (g_out) free(g_out);
	g_out = NULL;
	g_outlen = 0;
}
void *jr_malloc(unsigned long n) { return malloc(n ? n : 1); }
void jr_free(void *p) { free(p); }

static void on_error(j_common_ptr c) {
	g_last_error = c->err->msg_code ? c->err->msg_code : -1;
	__builtin_trap();
}
static void on_emit(j_common_ptr c, int level) {
	if (level < 0) ((struct jr_err *)c->err)->warnings++;
}
static void on_output(j_common_ptr c) { (void)c; }

/* Progressive files with absurd scan counts are refused (decoding cost). */
static void on_progress(j_common_ptr c) {
	if (c->is_decompressor && ((j_decompress_ptr)c)->input_scan_number > 1000) {
		g_last_error = -5;
		__builtin_trap();
	}
}

static void setup_err(struct jr_err *e) {
	jpeg_std_error(&e->pub);
	e->pub.error_exit = on_error;
	e->pub.emit_message = on_emit;
	e->pub.output_message = on_output;
	e->warnings = 0;
}

static int keep_marker(jpeg_saved_marker_ptr m) {
	if (m->marker == JPEG_APP0) return m->data_length >= 4 && !memcmp(m->data, "JFIF", 4);
	if (m->marker == JPEG_APP0 + 2) return m->data_length >= 12 && !memcmp(m->data, "ICC_PROFILE", 12);
	if (m->marker == JPEG_APP0 + 14) return m->data_length >= 5 && !memcmp(m->data, "Adobe", 5);
	return 0;
}

/* Coefficient buffers of one image, in bytes (what jpeg_read_coefficients allocates). */
static unsigned long coef_bytes(j_decompress_ptr s) {
	unsigned long total = 0;
	int ci;
	for (ci = 0; ci < s->num_components; ci++) {
		jpeg_component_info *p = &s->comp_info[ci];
		unsigned long w = p->width_in_blocks + p->h_samp_factor;
		unsigned long h = p->height_in_blocks + p->v_samp_factor;
		total += w * h * sizeof(JBLOCK);
	}
	return total;
}

/*
 * Returns 0 (output in jr_out_ptr/jr_out_len), -2 warnings (corrupt data), -3 unsupported
 * (not 8-bit, arithmetic, lossless), -4 coefficient buffers above max_coef; traps on errors.
 */
int jr_repack(const unsigned char *in, unsigned long n, unsigned long max_coef) {
	struct jpeg_decompress_struct s;
	struct jpeg_compress_struct d;
	struct jpeg_progress_mgr prog;
	struct jr_err es, ed;
	jvirt_barray_ptr *coef;
	jpeg_saved_marker_ptr mk;
	int rc = JR_OK;
	g_last_error = 0;
	jr_out_free();
	setup_err(&es);
	setup_err(&ed);
	s.err = &es.pub;
	d.err = &ed.pub;
	jpeg_create_decompress(&s);
	prog.progress_monitor = on_progress;
	s.progress = &prog;
	s.mem->max_memory_to_use = (long)(max_coef + (8ul << 20));
	jpeg_save_markers(&s, JPEG_APP0, 0xFFFF);
	jpeg_save_markers(&s, JPEG_APP0 + 2, 0xFFFF);
	jpeg_save_markers(&s, JPEG_APP0 + 14, 0xFFFF);
	jpeg_mem_src(&s, in, n);
	jpeg_read_header(&s, TRUE);
	if (s.arith_code || s.data_precision != 8) rc = JR_UNSUPPORTED;
	else if (es.warnings) rc = JR_WARNING;
	/* comp_info block counts are known once the header is read (first SOS reached) */
	if (rc == JR_OK && coef_bytes(&s) > max_coef) rc = JR_TOO_BIG;
	if (rc != JR_OK) {
		jpeg_destroy_decompress(&s);
		return rc;
	}
	coef = jpeg_read_coefficients(&s);
	if (es.warnings) {
		jpeg_destroy_decompress(&s);
		return JR_WARNING;
	}
	if (g_tamper) {
		JBLOCKARRAY r = (*s.mem->access_virt_barray)((j_common_ptr)&s, coef[0], 0, 1, TRUE);
		r[0][0][0] += g_tamper;
	}
	jpeg_create_compress(&d);
	jpeg_copy_critical_parameters(&s, &d);
	d.write_JFIF_header = FALSE;
	d.write_Adobe_marker = FALSE;
	d.optimize_coding = TRUE;
	d.restart_interval = 0;
	d.restart_in_rows = 0;
	jpeg_mem_dest(&d, &g_out, &g_outlen);
	jpeg_write_coefficients(&d, coef);
	for (mk = s.marker_list; mk; mk = mk->next)
		if (keep_marker(mk)) jpeg_write_marker(&d, mk->marker, mk->data, mk->data_length);
	jpeg_finish_compress(&d);
	jpeg_destroy_compress(&d);
	jpeg_finish_decompress(&s);
	jpeg_destroy_decompress(&s);
	if (es.warnings || ed.warnings) {
		jr_out_free();
		return JR_WARNING;
	}
	return JR_OK;
}

/* 0 identical, 1 different, -2 warnings in either, -4 too big; traps on errors. */
int jr_verify(const unsigned char *a, unsigned long na, const unsigned char *b, unsigned long nb, unsigned long max_coef) {
	struct jpeg_decompress_struct s1, s2;
	struct jpeg_progress_mgr p1, p2;
	struct jr_err e1, e2;
	jvirt_barray_ptr *c1, *c2;
	int ci, res = 0;
	g_last_error = 0;
	setup_err(&e1);
	setup_err(&e2);
	s1.err = &e1.pub;
	s2.err = &e2.pub;
	jpeg_create_decompress(&s1);
	jpeg_create_decompress(&s2);
	p1.progress_monitor = on_progress;
	p2.progress_monitor = on_progress;
	s1.progress = &p1;
	s2.progress = &p2;
	s1.mem->max_memory_to_use = (long)(max_coef + (8ul << 20));
	s2.mem->max_memory_to_use = (long)(max_coef + (8ul << 20));
	jpeg_mem_src(&s1, a, na);
	jpeg_mem_src(&s2, b, nb);
	jpeg_read_header(&s1, TRUE);
	jpeg_read_header(&s2, TRUE);
	if (s1.image_width != s2.image_width || s1.image_height != s2.image_height ||
	    s1.num_components != s2.num_components || s1.jpeg_color_space != s2.jpeg_color_space ||
	    s1.saw_JFIF_marker != s2.saw_JFIF_marker || s1.saw_Adobe_marker != s2.saw_Adobe_marker ||
	    s1.Adobe_transform != s2.Adobe_transform || s1.data_precision != s2.data_precision ||
	    s1.arith_code != s2.arith_code || s1.data_precision != 8 || s1.arith_code)
		res = 1;
	if (res == 0 && (coef_bytes(&s1) > max_coef || coef_bytes(&s2) > max_coef)) res = -4;
	if (res == 0) {
		c1 = jpeg_read_coefficients(&s1);
		c2 = jpeg_read_coefficients(&s2);
		if (e1.warnings || e2.warnings) res = -2;
		for (ci = 0; res == 0 && ci < s1.num_components; ci++) {
			jpeg_component_info *p = &s1.comp_info[ci], *q = &s2.comp_info[ci];
			JDIMENSION row;
			if (p->component_id != q->component_id || p->h_samp_factor != q->h_samp_factor ||
			    p->v_samp_factor != q->v_samp_factor || p->height_in_blocks != q->height_in_blocks ||
			    p->width_in_blocks != q->width_in_blocks) {
				res = 1;
				break;
			}
			if (!p->quant_table || !q->quant_table ||
			    memcmp(p->quant_table->quantval, q->quant_table->quantval, sizeof(p->quant_table->quantval))) {
				res = 1;
				break;
			}
			for (row = 0; row < p->height_in_blocks && res == 0; row++) {
				JBLOCKARRAY r1 = (*s1.mem->access_virt_barray)((j_common_ptr)&s1, c1[ci], row, 1, FALSE);
				JBLOCKARRAY r2 = (*s2.mem->access_virt_barray)((j_common_ptr)&s2, c2[ci], row, 1, FALSE);
				if (memcmp(r1[0], r2[0], sizeof(JBLOCK) * p->width_in_blocks)) res = 1;
			}
		}
	}
	jpeg_destroy_decompress(&s1);
	jpeg_destroy_decompress(&s2);
	return res;
}
