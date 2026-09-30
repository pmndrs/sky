// WebGPU has no layered rendering: his LutGS routes each instance of a
// full-screen triangle to one slice of the 32³ AP volume through
// SV_RenderTargetArrayIndex. Here the host draws one pass per slice into a
// 2D view of that slice, passes the slice index in a constant buffer, and
// this wrapper calls his RenderCameraVolumePS unchanged.
#include "Resources/RenderSkyRayMarching.hlsl"

cbuffer SliceCB : register(b2)
{
	uint gSlice;
};

struct SliceIn
{
	float4 position : SV_POSITION;
};

float4 CameraVolumeSlicePS(SliceIn i) : SV_TARGET0
{
	GeometryOutput g;
	g.position = i.position;
	g.sliceId = gSlice;
	return RenderCameraVolumePS(g);
}
